import { Inject, Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";
import type { Queue } from "bullmq";

import type { AttendanceRecord } from "../../common/generated/attendance_record.js";
import type { DeviceEvent } from "../../common/generated/device_event.js";
import type { Heartbeat } from "../../common/generated/heartbeat.js";
import { PrismaService } from "../../database/prisma.service.js";
import { DevicesService } from "../devices/devices.service.js";
import { KIOSK_EVENT, type KioskMessage } from "../mqtt/mqtt.events.js";
import { QUEUE_TOKEN, type Queues } from "../../queue/queue.module.js";
import { QUEUE } from "../../queue/queues.js";
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

  /** Keep what a kiosk reports, then show it. A fault nobody saw still counts. */
  @OnEvent(KIOSK_EVENT.event)
  async onEvent(message: KioskMessage<DeviceEvent>): Promise<void> {
    const body = message.payload;
    await this.devices.seen(message.deviceId, message.receivedAt);
    await this.db.deviceEvent.create({
      data: {
        deviceId: message.deviceId,
        type: body.type,
        severity: body.severity,
        employeeId: body.employeeId,
        livenessScore: body.livenessScore,
        cmdId: body.cmdId,
        errorCode: body.errorCode,
        message: body.message,
        ts: new Date(body.ts),
      },
    });
    this.feed.publish(FEED.event, body);
    if (body.severity === "ERROR") {
      // Telling someone is somebody else's job and may be slow, so it leaves
      // through the queue rather than holding up the broker callback.
      const queue: Queue = this.queues[QUEUE.notify];
      await queue.add(QUEUE.notify, { deviceId: message.deviceId, reason: body.type });
    }
  }

  @OnEvent(KIOSK_EVENT.attendance)
  onPunch(message: KioskMessage<AttendanceRecord>): void {
    this.feed.publish(FEED.attendance, message.payload);
  }

  @OnEvent(KIOSK_EVENT.heartbeat)
  onBeat(message: KioskMessage<Heartbeat>): void {
    this.feed.publish(FEED.device, message.payload);
  }

  @OnEvent(KIOSK_EVENT.status)
  async onStatus(message: KioskMessage<string>): Promise<void> {
    const online = message.payload === "online";
    await this.devices.setOnline(message.deviceId, online, message.receivedAt);
    this.feed.publish(FEED.device, { deviceId: message.deviceId, online });
  }
}
