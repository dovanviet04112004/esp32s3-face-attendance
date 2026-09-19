import { Injectable, Logger } from "@nestjs/common";

import type { AttendanceRecord } from "../../common/generated/attendance_record.js";
import { PrismaService } from "../../database/prisma.service.js";
import { DevicesService } from "../devices/devices.service.js";

const FOREIGN_KEY_VIOLATION = "P2003";

/** What became of one punch. */
export type PunchOutcome = "stored" | "duplicate" | "unknown-employee";

@Injectable()
export class AttendanceService {
  private readonly log = new Logger(AttendanceService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly devices: DevicesService,
  ) {}

  /** Store one punch, or recognise it as one already held. */
  async record(punch: AttendanceRecord, receivedAt: Date): Promise<PunchOutcome> {
    await this.devices.seen(punch.deviceId, receivedAt);
    const key = { deviceId: punch.deviceId, localId: punch.localId };
    const held = await this.db.attendanceRecord.findUnique({
      where: { deviceId_localId: key },
      select: { id: true },
    });
    if (held) {
      return "duplicate";
    }
    try {
      await this.db.attendanceRecord.create({
        data: {
          ...key,
          employeeId: punch.employeeId,
          ts: new Date(punch.ts),
          direction: punch.direction,
          score: punch.matchScore,
          livenessScore: punch.livenessScore,
          doorOpened: punch.doorOpened ?? false,
          capturedOffline: punch.capturedOffline ?? false,
          clockUnsynced: punch.clockUnsynced ?? false,
        },
      });
      return "stored";
    } catch (error) {
      if (isPrismaCode(error, FOREIGN_KEY_VIOLATION)) {
        this.log.error(`punch names employee ${punch.employeeId}, who is not on the roster`);
        return "unknown-employee";
      }
      // A second delivery can land between the read above and this write, and
      // the unique index is what settles it (CLAUDE.md 4.3).
      if (isPrismaCode(error, "P2002")) {
        return "duplicate";
      }
      throw error;
    }
  }
}

function isPrismaCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
