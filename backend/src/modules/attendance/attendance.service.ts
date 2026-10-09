import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Prisma, AttendanceRecord as Punch, PunchHold } from "@prisma/client";

import { COUNT_CEILING, countedTo, decodeCursor, nextCursor } from "../../common/dto/cursor.dto.js";
import type { Page } from "../../common/dto/pagination.dto.js";
import type { AttendanceRecord } from "../../common/generated/attendance_record.js";
import { ScopeService } from "../../common/scope/scope.service.js";
import type { Viewer } from "../../common/scope/viewer.js";
import type { Env } from "../../config/env.schema.js";
import { PrismaService } from "../../database/prisma.service.js";
import { DevicesService, EARLIEST_BELIEVABLE_MS } from "../devices/devices.service.js";
import { dayAsDate, localDay } from "../timesheet/local-day.js";
import { TimesheetService } from "../timesheet/timesheet.service.js";
import type { ListAttendanceDto } from "./dto/attendance.dto.js";

const FOREIGN_KEY_VIOLATION = "P2003";
const kDayMs = 86_400_000;
// How far past its receipt a punch may claim to be (KEHOACH 9.8).
const kAheadOfReceiptMs = kDayMs;

/** Whether a punch's own time is past believing: earlier than 2020, or more than a day past its receipt. */
export function isQuestionable(ts: Date, receivedAt: Date): boolean {
  return ts.getTime() < EARLIEST_BELIEVABLE_MS || ts.getTime() > receivedAt.getTime() + kAheadOfReceiptMs;
}

/** What became of one punch; a held one is stored, and counts only once HR accepts it (KEHOACH 9.8). */
export type PunchOutcome = "stored" | "held" | "duplicate" | "unknown-employee" | "while-revoked" | "not-on-device";

/** How many punches a person's range holds, and how many of them carry each flag. */
export interface PunchCounts {
  all: number;
  capturedOffline: number;
  clockUnsynced: number;
  questionableTime: number;
  held: number;
}

/** A range of instants from the query, or nothing when it names neither end. */
function rangeOf(query: ListAttendanceDto): Prisma.DateTimeFilter | undefined {
  if (query.from === undefined && query.to === undefined) {
    return undefined;
  }
  return {
    ...(query.from !== undefined ? { gte: new Date(query.from) } : {}),
    ...(query.to !== undefined ? { lt: new Date(query.to) } : {}),
  };
}

@Injectable()
export class AttendanceService {
  private readonly log = new Logger(AttendanceService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly devices: DevicesService,
    private readonly scope: ScopeService,
    private readonly timesheet: TimesheetService,
    private readonly config: ConfigService<Env, true>,
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
    if (query.held) {
      where.review = "PENDING";
    }
    const range = rangeOf(query);
    // A questionable punch's own time says nothing, so asking for those reads the range as arrival.
    if (query.questionableTime) {
      where.questionableTime = true;
      where.receivedAt = range;
    } else {
      where.ts = range;
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
      return { all: 0, capturedOffline: 0, clockUnsynced: 0, questionableTime: 0, held: 0 };
    }
    const whose: Prisma.AttendanceRecordWhereInput = {
      ...ScopeService.narrow("employeeId", visible),
      ...(query.employeeId !== undefined ? { employeeId: query.employeeId } : {}),
      ...(query.deviceId !== undefined ? { deviceId: query.deviceId } : {}),
    };
    const range = rangeOf(query);
    const where = { ...whose, ts: range };
    const [all, capturedOffline, clockUnsynced, questionableTime, held] = await this.db.$transaction([
      this.db.attendanceRecord.count({ where }),
      this.db.attendanceRecord.count({ where: { ...where, capturedOffline: true } }),
      this.db.attendanceRecord.count({ where: { ...where, clockUnsynced: true } }),
      this.db.attendanceRecord.count({ where: { ...whose, questionableTime: true, receivedAt: range } }),
      this.db.attendanceRecord.count({ where: { ...where, review: "PENDING" } }),
    ]);
    return { all, capturedOffline, clockUnsynced, questionableTime, held };
  }

  /** Store one punch, or recognise it as one already stored; a punch that counts at once rebuilds its finished day. */
  async record(punch: AttendanceRecord, receivedAt: Date): Promise<PunchOutcome> {
    await this.devices.seen(punch.deviceId, receivedAt);
    const ts = new Date(punch.ts);
    if (await this.devices.outsideFleetAt(punch.deviceId, ts)) {
      return "while-revoked";
    }
    const questionableTime = isQuestionable(ts, receivedAt);
    const key = { deviceId: punch.deviceId, localId: punch.localId };
    const known = await this.db.attendanceRecord.findUnique({
      where: { deviceId_localId: key },
      select: { id: true },
    });
    if (known) {
      return "duplicate";
    }
    // A questionable punch's own time says nothing, so its door is judged at its receipt.
    if (!(await this.onDoor(punch.deviceId, punch.employeeId, questionableTime ? receivedAt : ts))) {
      this.log.warn(`${punch.deviceId} sent a punch for employee ${punch.employeeId}, who is not on that door`);
      return "not-on-device";
    }
    const day = localDay(ts, this.config.get("APP_TIMEZONE", { infer: true }));
    const hold = questionableTime ? null : await this.holdFor(punch.employeeId, ts, receivedAt, day);
    try {
      await this.db.attendanceRecord.create({
        data: {
          ...key,
          employeeId: punch.employeeId,
          ts,
          receivedAt,
          questionableTime,
          hold,
          review: hold === null ? null : "PENDING",
          direction: punch.direction,
          score: punch.matchScore,
          livenessScore: punch.livenessScore,
          doorOpened: punch.doorOpened ?? false,
          capturedOffline: punch.capturedOffline ?? false,
          clockUnsynced: punch.clockUnsynced ?? false,
        },
      });
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
    if (hold !== null) {
      return "held";
    }
    // Any finished day, built yet or not: a punch landing while the nightly build runs is not lost.
    if (!questionableTime && day < this.timesheet.today()) {
      await this.timesheet.scheduleRebuild(punch.employeeId, day);
    }
    return "stored";
  }

  /** Whether the door holds the person, or still held them at `at` (KEHOACH 9.8). */
  private async onDoor(deviceId: string, employeeId: number, at: Date): Promise<boolean> {
    const pair = await this.db.deviceEnrollment.findUnique({
      where: { deviceId_employeeId: { deviceId, employeeId } },
      select: { state: true, revokedAt: true },
    });
    if (pair === null) {
      return false;
    }
    return pair.state !== "REVOKED" || (pair.revokedAt !== null && at < pair.revokedAt);
  }

  /** Why a believable punch waits for HR, or null when it counts at once (KEHOACH 9.8). */
  private async holdFor(employeeId: number, ts: Date, receivedAt: Date, day: string): Promise<PunchHold | null> {
    const window = this.config.get("PUNCH_REVIEW_AFTER_DAYS", { infer: true }) * kDayMs;
    if (receivedAt.getTime() - ts.getTime() > window) {
      return "LATE";
    }
    const person = await this.db.employee.findUnique({ where: { id: employeeId }, select: { legalEntityId: true } });
    const date = dayAsDate(day);
    // A company-wide period covers everyone; an entity's period covers its own people.
    const closed = await this.db.payrollPeriod.count({
      where: {
        state: { in: ["LOCKED", "PAID"] },
        startDate: { lte: date },
        endDate: { gte: date },
        OR: [{ legalEntityId: null }, ...(person?.legalEntityId ? [{ legalEntityId: person.legalEntityId }] : [])],
      },
    });
    return closed > 0 ? "CLOSED_PERIOD" : null;
  }
}

function isPrismaCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
