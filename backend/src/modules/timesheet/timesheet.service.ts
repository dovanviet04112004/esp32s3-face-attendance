import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { AttendanceDay, DayState } from "@prisma/client";

import type { Env } from "../../config/env.schema.js";
import { PrismaService } from "../../database/prisma.service.js";
import { clockToMinutes, dayAsDate, dayWindow, localDay, minutesIntoDay } from "./local-day.js";

const SATURDAY = 6;
const SUNDAY = 0;

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
    private readonly config: ConfigService<Env, true>,
  ) {}

  private get zone(): string {
    return this.config.get("APP_TIMEZONE", { infer: true });
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
    await this.db.$transaction(
      rows.map((row) =>
        this.db.attendanceDay.upsert({
          where: { employeeId_date: { employeeId: row.employeeId, date } },
          // A hand correction is not undone by a rebuild (KEHOACH 9.8).
          update: { ...row, adjustedById: undefined, adjustReason: undefined },
          create: row,
        }),
      ),
    );
    this.log.log(`built ${rows.length} day(s) for ${day} from ${punches.length} punch(es)`);
    return rows.length;
  }

  private dayOf(
    employeeId: number,
    date: Date,
    marks: { first: Date; last: Date; count: number; unsynced: boolean } | undefined,
    shift: ShiftClock | undefined,
    holiday: boolean,
    weekend: boolean,
  ) {
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
