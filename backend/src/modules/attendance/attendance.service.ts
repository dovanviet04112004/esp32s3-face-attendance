import { Injectable, Logger } from "@nestjs/common";
import type { Prisma, AttendanceRecord as Punch } from "@prisma/client";

import type { Page } from "../../common/dto/pagination.dto.js";
import type { AttendanceRecord } from "../../common/generated/attendance_record.js";
import { PrismaService } from "../../database/prisma.service.js";
import { DevicesService } from "../devices/devices.service.js";
import type { ListAttendanceDto } from "./dto/attendance.dto.js";

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

  /** One page of punches, newest first, narrowed by the filters the caller sends. */
  async list(query: ListAttendanceDto): Promise<Page<Punch>> {
    const where: Prisma.AttendanceRecordWhereInput = {};
    if (query.employeeId !== undefined) {
      where.employeeId = query.employeeId;
    }
    if (query.deviceId !== undefined) {
      where.deviceId = query.deviceId;
    }
    if (query.from !== undefined || query.to !== undefined) {
      where.ts = {
        ...(query.from !== undefined ? { gte: new Date(query.from) } : {}),
        ...(query.to !== undefined ? { lt: new Date(query.to) } : {}),
      };
    }
    // Both halves of one transaction so the pager's total cannot describe a
    // different set of rows than the page above it.
    const [rows, total] = await this.db.$transaction([
      this.db.attendanceRecord.findMany({
        where,
        orderBy: { ts: "desc" },
        skip: query.skip,
        take: query.take,
      }),
      this.db.attendanceRecord.count({ where }),
    ]);
    return { rows, total };
  }

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
