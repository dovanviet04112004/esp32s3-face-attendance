import { Injectable, Logger } from "@nestjs/common";
import { OnEvent } from "@nestjs/event-emitter";

import type { AttendanceRecord } from "../../common/generated/attendance_record.js";
import { KIOSK_EVENT, type KioskMessage } from "../mqtt/mqtt.events.js";
import { AttendanceService } from "./attendance.service.js";

@Injectable()
export class AttendanceListener {
  private readonly log = new Logger(AttendanceListener.name);

  constructor(private readonly attendance: AttendanceService) {}

  @OnEvent(KIOSK_EVENT.attendance)
  async onPunch(message: KioskMessage<AttendanceRecord>): Promise<void> {
    const punch = message.payload;
    const outcome = await this.attendance.record(punch, message.receivedAt);
    this.log.log(
      `${outcome}: ${punch.deviceId} localId ${punch.localId} employee ${punch.employeeId}`,
    );
  }
}
