import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";

import type { AttendanceRecord } from "../../common/generated/attendance_record.js";
import { KIOSK_EVENT, type KioskMessage } from "../mqtt/mqtt.events.js";
import { FEED, RealtimeGateway } from "../realtime/realtime.gateway.js";
import { AttendanceService, isQuestionable } from "./attendance.service.js";

@Injectable()
export class AttendanceListener {
  private readonly log = new Logger(AttendanceListener.name);

  constructor(
    private readonly attendance: AttendanceService,
    private readonly feed: RealtimeGateway,
  ) {}

  @OnEvent(KIOSK_EVENT.attendance, { suppressErrors: false })
  async onPunch(message: KioskMessage<AttendanceRecord>): Promise<void> {
    const punch = message.payload;
    // The topic names the kiosk the broker authenticated; the body is only what that kiosk claims.
    if (punch.deviceId !== message.deviceId) {
      this.log.warn(`${message.deviceId} sent a punch claiming to be ${punch.deviceId}, dropped`);
      return;
    }
    const outcome = await this.attendance.record(punch, message.receivedAt);
    this.log.log(
      `${outcome}: ${punch.deviceId} localId ${punch.localId} employee ${punch.employeeId}`,
    );
    if (outcome !== "stored") {
      return;
    }
    // Announced only once the row is written, since the dashboard answers by
    // asking for the list again.
    this.feed.publish(
      FEED.attendance,
      { ...punch, questionableTime: isQuestionable(new Date(punch.ts), message.receivedAt) },
      punch.employeeId,
    );
  }
}
