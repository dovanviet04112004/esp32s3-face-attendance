import { readFile } from "node:fs/promises";

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EventEmitter2 } from "@nestjs/event-emitter";
import mqtt, { type IClientOptions, type MqttClient } from "mqtt";

import { TOPICS, type TopicName, type TopicSpec } from "../../common/generated/topics.js";
import type { Env } from "../../config/env.schema.js";
import { PrismaService } from "../../database/prisma.service.js";
import { KIOSK_EVENT, type KioskMessage } from "./mqtt.events.js";

const RECONNECT_MS = 5000;
const CONNECT_TIMEOUT_MS = 10000;

@Injectable()
export class MqttService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(MqttService.name);
  private client?: MqttClient;

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly bus: EventEmitter2,
    private readonly db: PrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
    const options: IClientOptions = {
      username: this.config.get("MQTT_USERNAME", { infer: true }),
      password: this.config.get("MQTT_PASSWORD", { infer: true }),
      reconnectPeriod: RECONNECT_MS,
      connectTimeout: CONNECT_TIMEOUT_MS,
      protocolVersion: 5,
      clean: true,
    };
    const caPath = this.config.get("MQTT_CA_CERT_PATH", { infer: true });
    if (caPath) {
      // The broker is signed by the fleet's own authority, so the public trust
      // store has nothing to say about it (KEHOACH 7.4).
      options.ca = [await readFile(caPath)];
      options.rejectUnauthorized = true;
    }

    const client = mqtt.connect(this.config.get("MQTT_URL", { infer: true }), options);
    this.client = client;
    client.on("connect", () => {
      void this.subscribeUp(client);
    });
    client.on("error", (error) => this.log.error(`broker: ${error.message}`));
    client.on("message", (topic, payload) => {
      this.dispatch(topic, payload).catch((error: Error) =>
        this.log.error(`${topic} not handled: ${error.message}`),
      );
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client?.endAsync();
  }

  get connected(): boolean {
    return this.client?.connected ?? false;
  }

  /**
   * Send one message on a down topic.
   *
   * Up topics are refused here: the acl denies them to every service account
   * (KEHOACH 7.4), and a broker-side denial would arrive too late to see.
   */
  async publishDown(name: TopicName, deviceId: string, payload: unknown): Promise<void> {
    const spec = TOPICS[name];
    if (spec.direction !== "down") {
      throw new Error(`${name} is an up topic and the server never speaks on one`);
    }
    const parsed = spec.schema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`${name} payload does not match its schema`);
    }
    if (!this.client) {
      throw new Error("no broker connection");
    }
    await this.client.publishAsync(spec.build(deviceId), JSON.stringify(parsed.data), {
      qos: spec.qos,
      retain: spec.retained,
    });
  }

  private async subscribeUp(client: MqttClient): Promise<void> {
    const up = Object.values(TOPICS).filter((spec) => spec.direction === "up");
    for (const spec of up) {
      await client.subscribeAsync(spec.wildcard, { qos: spec.qos });
    }
    this.log.log(`subscribed to ${up.length} up topics as ${this.config.get("MQTT_USERNAME", { infer: true })}`);
  }

  private async dispatch(topic: string, raw: Buffer): Promise<void> {
    const match = this.match(topic);
    if (!match) {
      this.log.warn(`no contract for ${topic}`);
      return;
    }
    const { spec, deviceId } = match;
    const decoded = this.decode(spec, raw);
    if ("reason" in decoded) {
      this.log.warn(`${spec.name} from ${deviceId} refused: ${decoded.reason}`);
      return;
    }
    // A session outlives a revoke until the broker closes it (KEHOACH 7.4).
    if (!(await this.approved(deviceId))) {
      this.log.warn(`${spec.name} from ${deviceId} dropped: not an approved kiosk`);
      return;
    }
    const parsed = decoded.value;
    const message: KioskMessage = {
      topic: spec.name,
      deviceId,
      payload: parsed,
      receivedAt: new Date(),
    };
    this.log.debug(`${spec.name} from ${deviceId}, ${raw.length} B`);
    this.bus.emit(KIOSK_EVENT[spec.name as keyof typeof KIOSK_EVENT], message);
  }

  private async approved(deviceId: string): Promise<boolean> {
    const held = await this.db.device.findUnique({ where: { id: deviceId }, select: { status: true } });
    return held?.status === "APPROVED";
  }

  private decode(spec: TopicSpec, raw: Buffer): { value: unknown } | { reason: string } {
    const text = raw.toString("utf8");
    // The last will is a bare word, not json, so it never reaches a parser.
    if (spec.lastWill) {
      return { value: text };
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return { reason: `not json (${text.slice(0, 40)})` };
    }
    const result = spec.schema.safeParse(body);
    if (result.success) {
      return { value: result.data };
    }
    const where = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"} ${issue.message}`)
      .join("; ");
    return { reason: where };
  }

  private match(topic: string): { spec: TopicSpec; deviceId: string } | undefined {
    const parts = topic.split("/");
    for (const spec of Object.values(TOPICS)) {
      const shape = spec.wildcard.split("/");
      if (shape.length !== parts.length) {
        continue;
      }
      const fits = shape.every((segment, i) => segment === "+" || segment === parts[i]);
      if (fits) {
        return { spec, deviceId: parts[shape.indexOf("+")] };
      }
    }
    return undefined;
  }
}
