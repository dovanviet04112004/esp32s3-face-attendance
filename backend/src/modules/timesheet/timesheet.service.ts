import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { AttendanceDay, DayState } from "@prisma/client";

import type { Env } from "../../config/env.schema.js";
import { ScopeService } from "../../common/scope/scope.service.js";
import type { Viewer } from "../../common/scope/viewer.js";
import { PrismaService } from "../../database/prisma.service.js";
import type { ListDaysDto } from "./dto/timesheet.dto.js";
import { clockToMinutes, dayAsDate, dayWindow, localDay, minutesIntoDay } from "./local-day.js";

const SATURDAY = 6;
const SUNDAY = 0;

interface DayRow {
  employeeId: number;
  date: Date;
  state: DayState;
  shiftId: string | null;
  firstIn?: Date;
  lastOut?: Date;
  workedMinutes?: number;
  lateMinutes?: number;
  earlyLeaveMinutes?: number;
  overtimeMinutes?: number;
  punchCount: number;
  clockUnsynced?: boolean;
  measuredMinutes?: number;
}

export interface BuildReport {
  days: number;
  rows: number;
}

interface ShiftClock {
  shiftId: string;
  startMinutes: number;
  endMinutes: number;
  graceMinutes: number;
}

@Injectable()
export class TimesheetService {
  private readonly log = new Logger(TimesheetService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly scope: ScopeService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  private get zone(): string {
    return this.config.get("APP_TIMEZONE", { infer: true });
  }

  /** Day rows inside a range, narrowed to what this viewer may read. */
  async list(viewer: Viewer, query: ListDaysDto): Promise<AttendanceDay[]> {
    const visible = await this.scope.visibleEmployeeIds(viewer);
    const wanted =
      query.employeeId !== undefined
        ? visible === null || visible.includes(query.employeeId)
          ? [query.employeeId]
          : []
        : visible;
    return this.db.attendanceDay.findMany({
      where: {
        date: { gte: dayAsDate(query.from), lte: dayAsDate(query.to) },
        ...(wanted === null ? {} : { employeeId: { in: wanted } }),
        ...(query.departmentId ? { employee: { departmentId: query.departmentId } } : {}),
      },
      orderBy: [{ date: "asc" }, { employeeId: "asc" }],
      take: 5000,
    });
  }

  /** Build every finished day in a range, oldest first. */
  async buildRange(from: string, to: string): Promise<BuildReport> {
    let days = 0;
    let rows = 0;
    for (let at = dayAsDate(from); at <= dayAsDate(to); at.setUTCDate(at.getUTCDate() + 1)) {
      const day = at.toISOString().slice(0, 10);
      const built = await this.build(day);
      if (built > 0) {
        days += 1;
        rows += built;
      }
    }
    return { days, rows };
  }

  /** The day today falls on, which build refuses because it is still running. */
  today(): string {
    return localDay(new Date(), this.zone);
  }

  /** Fold one local day's punches into one row per person.
   *  @ctx queue | blocking | safe to run again: it upserts on (employee, date)
   */
  async build(day: string): Promise<number> {
    if (day >= this.today()) {
      // A day still in progress summarises to a wrong number (KEHOACH 9.8).
      this.log.warn(`refusing to build ${day}: it has not finished`);
      return 0;
    }
    const { from, to } = dayWindow(day, this.zone);
    const date = dayAsDate(day);
    const [punches, staff, holiday] = await Promise.all([
      this.db.attendanceRecord.findMany({
        where: { ts: { gte: from, lt: to } },
        select: { employeeId: true, ts: true, clockUnsynced: true },
        orderBy: { ts: "asc" },
      }),
      this.db.employee.findMany({ where: { active: true }, select: { id: true } }),
      this.db.holiday.findFirst({ where: { date } }),
    ]);
    const shifts = await this.shiftsOn(date);

    const seen = new Map<number, { first: Date; last: Date; count: number; unsynced: boolean }>();
    for (const punch of punches) {
      const held = seen.get(punch.employeeId);
      if (held) {
        held.last = punch.ts;
        held.count += 1;
        held.unsynced = held.unsynced || punch.clockUnsynced;
      } else {
        seen.set(punch.employeeId, {
          first: punch.ts,
          last: punch.ts,
          count: 1,
          unsynced: punch.clockUnsynced,
        });
      }
    }

    const weekend = [SATURDAY, SUNDAY].includes(date.getUTCDay());
    const rows = staff.map((person) => this.dayOf(person.id, date, seen.get(person.id), shifts.get(person.id), holiday !== null, weekend));
    await this.write(date, rows);
    this.log.log(`built ${rows.length} day(s) for ${day} from ${punches.length} punch(es)`);
    return rows.length;
  }

  /** One statement for the whole day: an upsert per person is one round trip
   *  per person, which stops finishing overnight at scale (KEHOACH 9.9).
   */
  private async write(date: Date, rows: DayRow[]): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    await this.db.$executeRaw`
      INSERT INTO "AttendanceDay" (
        "employeeId", "date", "state", "shiftId", "firstIn", "lastOut",
        "workedMinutes", "lateMinutes", "earlyLeaveMinutes", "overtimeMinutes",
        "punchCount", "clockUnsynced", "measuredMinutes", "builtAt", "updatedAt")
      SELECT v."employeeId", ${date}::date, v."state"::"DayState", v."shiftId",
             v."firstIn", v."lastOut", v."workedMinutes", v."lateMinutes",
             v."earlyLeaveMinutes", v."overtimeMinutes", v."punchCount",
             v."clockUnsynced", v."measuredMinutes", now(), now()
        FROM unnest(
               ${rows.map((row) => row.employeeId)}::int[],
               ${rows.map((row) => row.state)}::text[],
               ${rows.map((row) => row.shiftId ?? null)}::text[],
               ${rows.map((row) => row.firstIn ?? null)}::timestamptz[],
               ${rows.map((row) => row.lastOut ?? null)}::timestamptz[],
               ${rows.map((row) => row.workedMinutes ?? 0)}::int[],
               ${rows.map((row) => row.lateMinutes ?? 0)}::int[],
               ${rows.map((row) => row.earlyLeaveMinutes ?? 0)}::int[],
               ${rows.map((row) => row.overtimeMinutes ?? 0)}::int[],
               ${rows.map((row) => row.punchCount)}::int[],
               ${rows.map((row) => row.clockUnsynced ?? false)}::bool[],
               ${rows.map((row) => row.measuredMinutes ?? null)}::int[]
             ) AS v("employeeId", "state", "shiftId", "firstIn", "lastOut",
                    "workedMinutes", "lateMinutes", "earlyLeaveMinutes",
                    "overtimeMinutes", "punchCount", "clockUnsynced", "measuredMinutes")
      ON CONFLICT ("employeeId", "date") DO UPDATE SET
        "state" = EXCLUDED."state",
        "shiftId" = EXCLUDED."shiftId",
        "firstIn" = EXCLUDED."firstIn",
        "lastOut" = EXCLUDED."lastOut",
        "workedMinutes" = EXCLUDED."workedMinutes",
        "lateMinutes" = EXCLUDED."lateMinutes",
        "earlyLeaveMinutes" = EXCLUDED."earlyLeaveMinutes",
        "overtimeMinutes" = EXCLUDED."overtimeMinutes",
        "punchCount" = EXCLUDED."punchCount",
        "clockUnsynced" = EXCLUDED."clockUnsynced",
        "measuredMinutes" = EXCLUDED."measuredMinutes",
        "updatedAt" = now()
      WHERE "AttendanceDay"."adjustedById" IS NULL
    `;
  }

  private dayOf(
    employeeId: number,
    date: Date,
    marks: { first: Date; last: Date; count: number; unsynced: boolean } | undefined,
    shift: ShiftClock | undefined,
    holiday: boolean,
    weekend: boolean,
  ): DayRow {
    if (!marks) {
      const state: DayState = holiday ? "HOLIDAY" : weekend ? "WEEKEND" : "ABSENT";
      return { employeeId, date, state, shiftId: shift?.shiftId ?? null, punchCount: 0 };
    }
    const inAt = minutesIntoDay(marks.first, this.zone);
    const outAt = minutesIntoDay(marks.last, this.zone);
    const worked = Math.max(0, outAt - inAt);
    const late = shift ? Math.max(0, inAt - (shift.startMinutes + shift.graceMinutes)) : 0;
    const early = shift ? Math.max(0, shift.endMinutes - outAt) : 0;
    const over = shift ? Math.max(0, outAt - shift.endMinutes) : 0;
    return {
      employeeId,
      date,
      state: "WORKED" as DayState,
      shiftId: shift?.shiftId ?? null,
      firstIn: marks.first,
      lastOut: marks.last,
      workedMinutes: worked,
      measuredMinutes: worked,
      lateMinutes: late,
      earlyLeaveMinutes: early,
      // Counted, not paid: only minutes matching an approved request become
      // money, which E17-T8 enforces (KEHOACH 9.17).
      overtimeMinutes: over,
      punchCount: marks.count,
      clockUnsynced: marks.unsynced,
    };
  }

  private async shiftsOn(date: Date): Promise<Map<number, ShiftClock>> {
    const rows = await this.db.shiftAssignment.findMany({
      where: { validFrom: { lte: date }, OR: [{ validTo: null }, { validTo: { gte: date } }] },
      include: { shift: true },
    });
    const byEmployee = new Map<number, ShiftClock>();
    for (const row of rows) {
      byEmployee.set(row.employeeId, {
        shiftId: row.shiftId,
        startMinutes: clockToMinutes(row.shift.startTime),
        endMinutes: clockToMinutes(row.shift.endTime),
        graceMinutes: row.shift.graceMinutes,
      });
    }
    return byEmployee;
  }

  /** One person's month, for the portal. */
  month(employeeId: number, year: number, month: number): Promise<AttendanceDay[]> {
    const from = new Date(Date.UTC(year, month - 1, 1));
    const to = new Date(Date.UTC(year, month, 1));
    return this.db.attendanceDay.findMany({
      where: { employeeId, date: { gte: from, lt: to } },
      orderBy: { date: "asc" },
    });
  }
}
