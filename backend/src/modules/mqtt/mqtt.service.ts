import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EventEmitter2 } from "@nestjs/event-emitter";
import mqtt, { type IClientOptions, type IPublishPacket, type MqttClient } from "mqtt";

import { TOPICS, type TopicName, type TopicSpec } from "../../common/generated/topics.js";
import type { Env } from "../../config/env.schema.js";
import { PrismaService } from "../../database/prisma.service.js";
import { KIOSK_EVENT, type KioskMessage } from "./mqtt.events.js";

const RECONNECT_MS = 5000;
const CONNECT_TIMEOUT_MS = 10000;
const BROKER_API_TIMEOUT_MS = 5000;
const SESSION_EXPIRY_S = 7 * 24 * 3600;
const HANDLER_TRIES = 5;
const RETRY_FIRST_MS = 1000;
const RETRY_CEILING_MS = 30_000;
// Retain Handling 1: a subscription the session already holds gets no replay.
const REPLAY_ONLY_WHEN_NEW = 1;
// Stands in for mqtt.js's own PUBACK, which settle() sends once the handler is done.
const DEFERRED = new Error("acknowledged after the handler");

type Match = { spec: TopicSpec; deviceId: string };
type Acker = { _sendPacket(packet: { cmd: "puback"; messageId: number; reasonCode: number }): void };

@Injectable()
export class MqttService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(MqttService.name);
  private client?: MqttClient;
  // A packet id names a message only on the connection that carried it.
  private link = 0;
  private closing = false;
  private readonly lanes = new Map<string, Promise<void>>();

  constructor(
    private readonly config: ConfigService<Env, true>,
    private readonly bus: EventEmitter2,
    private readonly db: PrismaService,
  ) {}

  async onModuleInit(): Promise<void> {
    const clientId = this.config.get("MQTT_CLIENT_ID", { infer: true });
    const options: IClientOptions = {
      username: this.config.get("MQTT_USERNAME", { infer: true }),
      password: this.config.get("MQTT_PASSWORD", { infer: true }),
      reconnectPeriod: RECONNECT_MS,
      connectTimeout: CONNECT_TIMEOUT_MS,
      protocolVersion: 5,
      ...(clientId
        ? { clientId, clean: false, properties: { sessionExpiryInterval: SESSION_EXPIRY_S } }
        : { clean: true }),
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
    // mqtt.js acks inside its read loop, where a handler awaiting its own PUBACK would wait forever.
    client.handleMessage = (packet, done) => {
      this.receive(client, packet, this.link);
      done(DEFERRED);
    };
    client.on("connect", () => {
      this.link += 1;
      this.subscribeUp(client).catch((error: Error) => this.log.error(`subscribe failed: ${error.message}`));
    });
    client.on("error", (error) => this.log.error(`broker: ${error.message}`));
  }

  async onModuleDestroy(): Promise<void> {
    this.closing = true;
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

  /**
   * Forget the logins the broker cached, then close this kiosk's session, so a
   * revoked ticket stops now rather than at its next connect (KEHOACH 7.4).
   * Best effort: false when the broker api is unset or refuses.
   */
  async closeSession(deviceId: string): Promise<boolean> {
    const base = this.config.get("EMQX_API_URL", { infer: true });
    const password = this.config.get("EMQX_API_PASSWORD", { infer: true });
    if (!base || !password) {
      this.log.warn(`no broker api, ${deviceId} keeps its session until it drops`);
      return false;
    }
    try {
      const login = await this.brokerApi(`${base}/login`, "POST", {
        username: this.config.get("EMQX_API_USERNAME", { infer: true }),
        password,
      });
      const { token } = (await login.json()) as { token: string };
      await this.brokerApi(`${base}/authentication/node_cache/reset`, "POST", undefined, token);
      // 404: no session is open, which is the state a revoke wants.
      await this.brokerApi(`${base}/clients/${encodeURIComponent(deviceId)}`, "DELETE", undefined, token, [404]);
      this.log.log(`${deviceId}: broker session closed`);
      return true;
    } catch (error) {
      this.log.warn(`${deviceId} keeps its broker session: ${(error as Error).message}`);
      return false;
    }
  }

  private async brokerApi(
    url: string,
    method: "POST" | "DELETE",
    body?: object,
    token?: string,
    alsoFine: readonly number[] = [],
  ): Promise<Response> {
    const res = await fetch(url, {
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(BROKER_API_TIMEOUT_MS),
    });
    if (!res.ok && !alsoFine.includes(res.status)) {
      throw new Error(`${method} ${new URL(url).pathname} answered ${res.status}`);
    }
    return res;
  }

  private async subscribeUp(client: MqttClient): Promise<void> {
    const up = Object.values(TOPICS).filter((spec) => spec.direction === "up");
    for (const spec of up) {
      await client.subscribeAsync(spec.wildcard, { qos: spec.qos, rh: REPLAY_ONLY_WHEN_NEW });
    }
    this.log.log(`subscribed to ${up.length} up topics as ${this.config.get("MQTT_USERNAME", { infer: true })}`);
  }

  // One kiosk's messages are handled in the order they arrived; kiosks do not wait on each other.
  private receive(client: MqttClient, packet: IPublishPacket, link: number): void {
    const match = this.match(packet.topic);
    if (!match) {
      this.log.warn(`no contract for ${packet.topic}`);
      this.settle(client, packet, link);
      return;
    }
    const receivedAt = new Date();
    const tail = (this.lanes.get(match.deviceId) ?? Promise.resolve()).then(async () => {
      try {
        if (await this.dispatch(match, packet, receivedAt, link)) {
          this.settle(client, packet, link);
        }
      } catch (error) {
        this.log.error(`${packet.topic} not handled: ${(error as Error).message}`);
      }
    });
    this.lanes.set(match.deviceId, tail);
    void tail.finally(() => {
      if (this.lanes.get(match.deviceId) === tail) {
        this.lanes.delete(match.deviceId);
      }
    });
  }

  /** Whether the message is finished with: handled, or refused for good. False leaves it with the broker. */
  private async dispatch(match: Match, packet: IPublishPacket, receivedAt: Date, link: number): Promise<boolean> {
    const { spec, deviceId } = match;
    const decoded = this.decode(spec, Buffer.from(packet.payload));
    if ("reason" in decoded) {
      this.log.warn(`${spec.name} from ${deviceId} refused: ${decoded.reason}`);
      return true;
    }
    const message: KioskMessage = {
      topic: spec.name,
      deviceId,
      payload: decoded.value,
      receivedAt,
      retained: packet.retain,
    };
    let failed = 0;
    for (let waitMs = RETRY_FIRST_MS; ; waitMs = Math.min(waitMs * 2, RETRY_CEILING_MS)) {
      try {
        // A session outlives a revoke until the broker closes it (KEHOACH 7.4).
        if (!(await this.approved(deviceId))) {
          this.log.warn(`${spec.name} from ${deviceId} dropped: not an approved kiosk`);
          return true;
        }
        this.log.debug(`${spec.name} from ${deviceId}, ${packet.payload.length} B`);
        await this.bus.emitAsync(KIOSK_EVENT[spec.name as keyof typeof KIOSK_EVENT], message);
        return true;
      } catch (error) {
        const why = (error as Error).message;
        if (packet.qos === 0) {
          this.log.error(`${spec.name} from ${deviceId} not handled: ${why}`);
          return true;
        }
        if (this.closing || link !== this.link || !this.client?.connected) {
          this.log.warn(`${spec.name} from ${deviceId} left to the broker to deliver again: ${why}`);
          return false;
        }
        // Only a failure while the database answers counts against the message itself.
        failed += (await this.databaseAnswers()) ? 1 : 0;
        if (failed >= HANDLER_TRIES) {
          this.log.error(`${spec.name} from ${deviceId} dropped after ${failed} tries: ${why}`);
          return true;
        }
        this.log.warn(`${spec.name} from ${deviceId} failed, again in ${waitMs} ms: ${why}`);
        await sleep(waitMs, undefined, { ref: false });
      }
    }
  }

  private settle(client: MqttClient, packet: IPublishPacket, link: number): void {
    if (packet.qos !== 1 || packet.messageId === undefined || link !== this.link || !client.connected) {
      return;
    }
    (client as unknown as Acker)._sendPacket({ cmd: "puback", messageId: packet.messageId, reasonCode: 0 });
  }

  private async databaseAnswers(): Promise<boolean> {
    try {
      await this.db.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
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

  private match(topic: string): Match | undefined {
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
