import { Injectable, Logger } from "@nestjs/common";
import type { Prisma, AttendanceRecord as Punch } from "@prisma/client";

import { COUNT_CEILING, countedTo, decodeCursor, nextCursor } from "../../common/dto/cursor.dto.js";
import type { Page } from "../../common/dto/pagination.dto.js";
import type { AttendanceRecord } from "../../common/generated/attendance_record.js";
import { ScopeService } from "../../common/scope/scope.service.js";
import type { Viewer } from "../../common/scope/viewer.js";
import { PrismaService } from "../../database/prisma.service.js";
import { DevicesService } from "../devices/devices.service.js";
import type { ListAttendanceDto } from "./dto/attendance.dto.js";

const FOREIGN_KEY_VIOLATION = "P2003";

/** What became of one punch. */
export type PunchOutcome = "stored" | "duplicate" | "unknown-employee" | "while-revoked";

/** How many punches a person's range holds, and how many of them carry each flag. */
export interface PunchCounts {
  all: number;
  capturedOffline: number;
  clockUnsynced: number;
}

@Injectable()
export class AttendanceService {
  private readonly log = new Logger(AttendanceService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly devices: DevicesService,
    private readonly scope: ScopeService,
  ) {}

  /** One page of punches, newest first, narrowed by the filters the caller sends. */
  async list(query: ListAttendanceDto, viewer: Viewer): Promise<Page<Punch>> {
    const visible = await this.scope.visibleEmployeeIds(viewer);
    const where: Prisma.AttendanceRecordWhereInput = {
      ...ScopeService.narrow("employeeId", visible),
    };
    // An explicit filter narrows further, it never widens past the scope.
    if (query.employeeId !== undefined && (visible === null || visible.includes(query.employeeId))) {
      where.employeeId = query.employeeId;
    } else if (query.employeeId !== undefined) {
      return { rows: [], total: 0, totalIsExact: true, next: null };
    }
    if (query.deviceId !== undefined) {
      where.deviceId = query.deviceId;
    }
    if (query.capturedOffline) {
      where.capturedOffline = true;
    }
    if (query.clockUnsynced) {
      where.clockUnsynced = true;
    }
    if (query.from !== undefined || query.to !== undefined) {
      where.ts = {
        ...(query.from !== undefined ? { gte: new Date(query.from) } : {}),
        ...(query.to !== undefined ? { lt: new Date(query.to) } : {}),
      };
    }
    const from = query.cursor ? decodeCursor(query.cursor) : null;
    const at = from ? new Date(from.sortValue) : null;
    // The lte is the only half Postgres turns into an index bound; without it
    // the scan walks every row above the cursor again (KEHOACH 9.9 rule 3).
    const resumed: Prisma.AttendanceRecordWhereInput =
      at && from
        ? {
            AND: [
              where,
              { ts: { lte: at } },
              { OR: [{ ts: { lt: at } }, { ts: at, id: { lt: BigInt(from.id) } }] },
            ],
          }
        : where;
    // Both halves of one transaction so the pager's total cannot describe a
    // different set of rows than the page above it.
    const [rows, found] = await this.db.$transaction([
      this.db.attendanceRecord.findMany({
        where: resumed,
        orderBy: [{ ts: "desc" }, { id: "desc" }],
        skip: from ? 0 : query.skip,
        take: query.take,
      }),
      this.db.attendanceRecord.count({ where, take: COUNT_CEILING + 1 }),
    ]);
    return {
      rows,
      ...countedTo(found),
      next: nextCursor(rows, query.take, (row) => row.ts),
    };
  }

  /** The counts a person's punch filter shows beside each choice, over the same range and scope. */
  async counts(query: ListAttendanceDto, viewer: Viewer): Promise<PunchCounts> {
    const visible = await this.scope.visibleEmployeeIds(viewer);
    if (query.employeeId !== undefined && visible !== null && !visible.includes(query.employeeId)) {
      return { all: 0, capturedOffline: 0, clockUnsynced: 0 };
    }
    const where: Prisma.AttendanceRecordWhereInput = {
      ...ScopeService.narrow("employeeId", visible),
      ...(query.employeeId !== undefined ? { employeeId: query.employeeId } : {}),
      ...(query.deviceId !== undefined ? { deviceId: query.deviceId } : {}),
      ...(query.from !== undefined || query.to !== undefined
        ? {
            ts: {
              ...(query.from !== undefined ? { gte: new Date(query.from) } : {}),
              ...(query.to !== undefined ? { lt: new Date(query.to) } : {}),
            },
          }
        : {}),
    };
    const [all, capturedOffline, clockUnsynced] = await this.db.$transaction([
      this.db.attendanceRecord.count({ where }),
      this.db.attendanceRecord.count({ where: { ...where, capturedOffline: true } }),
      this.db.attendanceRecord.count({ where: { ...where, clockUnsynced: true } }),
    ]);
    return { all, capturedOffline, clockUnsynced };
  }

  /** Store one punch, or recognise it as one already held. */
  async record(punch: AttendanceRecord, receivedAt: Date): Promise<PunchOutcome> {
    await this.devices.seen(punch.deviceId, receivedAt);
    if (await this.devices.outsideFleetAt(punch.deviceId, new Date(punch.ts))) {
      return "while-revoked";
    }
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
