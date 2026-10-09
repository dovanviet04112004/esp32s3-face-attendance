import { Inject, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import type { Prisma } from "@prisma/client";
import type { Queue } from "bullmq";

import type { DeviceEvent } from "../../common/generated/device_event.js";
import { PrismaService } from "../../database/prisma.service.js";
import { DEVICE_CHANGED, type DeviceChange, DevicesService } from "../devices/devices.service.js";
import { KIOSK_EVENT, type KioskMessage } from "../mqtt/mqtt.events.js";
import { QUEUE_TOKEN, type Queues } from "../../queue/queue.module.js";
import { JOB, QUEUE } from "../../queue/queues.js";
import { FEED, RealtimeGateway } from "./realtime.gateway.js";

@Injectable()
export class RealtimeListener {
  private readonly log = new Logger(RealtimeListener.name);

  constructor(
    private readonly db: PrismaService,
    private readonly feed: RealtimeGateway,
    private readonly devices: DevicesService,
    @Inject(QUEUE_TOKEN) private readonly queues: Queues,
  ) {}

  /** Keep what a kiosk reports, then show it, once per seq. A fault nobody saw still counts. */
  @OnEvent(KIOSK_EVENT.event, { suppressErrors: false })
  async onEvent(message: KioskMessage<DeviceEvent>): Promise<void> {
    const body = message.payload;
    await this.devices.seen(message.deviceId, message.receivedAt);
    if (!(await this.keep(message))) {
      this.log.debug(`${message.deviceId} event seq ${body.seq} already held, not shown again`);
      return;
    }
    this.feed.publish(FEED.event, body);
    if (body.severity === "ERROR") {
      // Telling someone is somebody else's job and may be slow, so it leaves
      // through the queue rather than holding up the broker callback.
      const queue: Queue = this.queues[QUEUE.notify];
      await queue.add(JOB.webhook, { deviceId: message.deviceId, reason: body.type });
    }
  }

  // False for a redelivery: (deviceId, seq) is unique, and a row without seq never collides (KEHOACH 4.6).
  private async keep(message: KioskMessage<DeviceEvent>): Promise<boolean> {
    const body = message.payload;
    const row: Prisma.DeviceEventCreateManyInput = {
      deviceId: message.deviceId,
      seq: body.seq,
      type: body.type,
      severity: body.severity,
      employeeId: body.employeeId,
      livenessScore: body.livenessScore,
      cmdId: body.cmdId,
      errorCode: body.errorCode,
      message: body.message,
      ts: new Date(body.ts),
      receivedAt: message.receivedAt,
    };
    if (body.seq === undefined) {
      await this.db.deviceEvent.create({ data: row });
      return true;
    }
    const made = await this.db.deviceEvent.createMany({ data: [row], skipDuplicates: true });
    return made.count === 1;
  }

  @OnEvent(DEVICE_CHANGED)
  onDeviceChanged(change: DeviceChange): void {
    this.feed.publish(FEED.device, change);
  }

  @OnEvent(KIOSK_EVENT.status, { suppressErrors: false })
  async onStatus(message: KioskMessage<string>): Promise<void> {
    const online = message.payload === "online";
    await this.devices.setOnline(message.deviceId, online, message.receivedAt, !message.retained);
    this.feed.publish(FEED.device, { deviceId: message.deviceId, online });
  }
}
