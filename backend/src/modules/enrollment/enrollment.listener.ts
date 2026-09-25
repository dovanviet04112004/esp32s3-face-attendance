import { Injectable } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";

import type { EnrollPayload } from "../../common/generated/enroll_payload.js";
import type { Heartbeat } from "../../common/generated/heartbeat.js";
import { DevicesService } from "../devices/devices.service.js";
import { KIOSK_EVENT, type KioskMessage } from "../mqtt/mqtt.events.js";
import { FEED, RealtimeGateway } from "../realtime/realtime.gateway.js";
import { EnrollmentService } from "./enrollment.service.js";

@Injectable()
export class EnrollmentListener {
  constructor(
    private readonly enrollment: EnrollmentService,
    private readonly devices: DevicesService,
    private readonly feed: RealtimeGateway,
  ) {}

  @OnEvent(KIOSK_EVENT.enroll_report, { suppressErrors: false })
  onReport(message: KioskMessage<EnrollPayload>): Promise<void> {
    return this.enrollment.takeReport(message.deviceId, message.payload);
  }

  @OnEvent(KIOSK_EVENT.heartbeat, { suppressErrors: false })
  async onHeartbeat(message: KioskMessage<Heartbeat>): Promise<void> {
    await this.devices.applyHeartbeat(message.deviceId, message.payload, message.receivedAt, !message.retained);
    // A retained copy is the broker's replay, not the kiosk speaking (KEHOACH 7.5).
    if (message.retained) {
      return;
    }
    // Told only once the row holds it, since the dashboard answers by reading the row.
    this.feed.publish(FEED.device, message.payload);
    await this.enrollment.converge(message.deviceId, message.payload.rosterVersion, message.receivedAt);
  }
}
