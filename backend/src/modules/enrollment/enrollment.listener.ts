import { Injectable } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";

import type { EnrollPayload } from "../../common/generated/enroll_payload.js";
import type { Heartbeat } from "../../common/generated/heartbeat.js";
import { DevicesService } from "../devices/devices.service.js";
import { KIOSK_EVENT, type KioskMessage } from "../mqtt/mqtt.events.js";
import { EnrollmentService } from "./enrollment.service.js";

@Injectable()
export class EnrollmentListener {
  constructor(
    private readonly enrollment: EnrollmentService,
    private readonly devices: DevicesService,
  ) {}

  @OnEvent(KIOSK_EVENT.enroll_report)
  onReport(message: KioskMessage<EnrollPayload>): Promise<void> {
    return this.enrollment.takeReport(message.deviceId, message.payload);
  }

  @OnEvent(KIOSK_EVENT.heartbeat)
  async onHeartbeat(message: KioskMessage<Heartbeat>): Promise<void> {
    await this.devices.applyHeartbeat(message.deviceId, message.payload, message.receivedAt);
    await this.enrollment.converge(message.deviceId, message.payload.rosterVersion);
  }
}
