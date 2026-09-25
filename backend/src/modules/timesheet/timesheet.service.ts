import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  type OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma, type AttendanceDay, type DayCalendar, type DayState } from "@prisma/client";

import type { Env } from "../../config/env.schema.js";
import { toExcelCsv } from "../../common/csv.js";
import {
  COUNT_CEILING,
  countedTo,
  decodeCursor,
  encodeCursor,
} from "../../common/dto/cursor.dto.js";
import type { Page } from "../../common/dto/pagination.dto.js";
import { ScopeService } from "../../common/scope/scope.service.js";
import type { Viewer } from "../../common/scope/viewer.js";
import { PrismaService } from "../../database/prisma.service.js";
import { QUEUE_TOKEN, type Queues } from "../../queue/queue.module.js";
import { AUDIT_ACTIONS, AUDIT_SUBJECTS } from "../audit/audit-actions.js";
import { AuditService } from "../audit/audit.service.js";
import { JOB, QUEUE, type RebuildJob, type TimesheetJob } from "../../queue/queues.js";
import type { CorrectDayDto, ListDaysDto, SummaryQueryDto } from "./dto/timesheet.dto.js";
import { clockToMinutes, dayAsDate, dayWindow, localDay, minutesIntoDay } from "./local-day.js";

const SATURDAY = 6;
const SUNDAY = 0;
const DAY_ID = /^\d{1,19}$/;
const kMsPerDay = 86_400_000;
// Half past midnight read in APP_TIMEZONE rather than the server's UTC (KEHOACH 9.8).
const kNightlyCron = "30 0 * * *";
const kNightlyScheduler = "timesheet-nightly";

const SUMMED = Prisma.sql`
  count(*) FILTER (WHERE d."state" = 'WORKED')::int          AS "workedDays",
  count(*) FILTER (WHERE d."state" = 'LEAVE')::int           AS "leaveDays",
  count(*) FILTER (WHERE d."state" = 'ABSENT')::int          AS "absentDays",
  coalesce(sum(d."workedMinutes"), 0)::int                   AS "workedMinutes",
  coalesce(sum(d."lateMinutes"), 0)::int                     AS "lateMinutes",
  coalesce(sum(d."overtimeMinutes"), 0)::int                 AS "overtimeMinutes",
  count(*) FILTER (WHERE d."adjustedById" IS NOT NULL)::int  AS "adjustedDays"`;

// What a desk has to look at: nobody came, somebody came late, or the day holds a hand correction.
const EXCEPTION_DAY = Prisma.sql`(d."state" = 'ABSENT' OR d."lateMinutes" > 0 OR d."adjustedById" IS NOT NULL)`;

/** A department and every department under it, as a subquery for `IN (...)`. */
export function branchOf(departmentId: string): Prisma.Sql {
  return Prisma.sql`
    WITH RECURSIVE branch AS (
      SELECT "id" FROM "Department" WHERE "id" = ${departmentId}
      UNION
      SELECT c."id" FROM "Department" c JOIN branch b ON c."parentId" = b."id"
    )
    SELECT "id" FROM branch`;
}

type DatedHoliday = { legalEntityId: string | null; paid: boolean };

/** What one date is to somebody of a legal entity, given the holidays declared on that date.
 *  The one definition of a working day: the day build writes it, leave is charged by it (KEHOACH 9.5).
 */
export function calendarOn(date: Date, holidays: DatedHoliday[], legalEntityId: string | null): DayCalendar {
  // An entity's own holiday outranks a company-wide one on the same date.
  const holiday =
    holidays.find((one) => one.legalEntityId !== null && one.legalEntityId === legalEntityId) ??
    holidays.find((one) => one.legalEntityId === null);
  if (holiday) {
    return holiday.paid ? "HOLIDAY" : "UNPAID_HOLIDAY";
  }
  return [SATURDAY, SUNDAY].includes(date.getUTCDay()) ? "WEEKEND" : "WORKDAY";
}

/** A search term as an ILIKE pattern, with the wildcards a person typed taken literally. */
export function likeOf(term: string): string {
  return `%${term.replace(/[\\%_]/g, "\\$&")}%`;
}

interface DayRow {
  employeeId: number;
  date: Date;
  state: DayState;
  calendar: DayCalendar;
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

export interface DaySummary {
  employeeId: number;
  code: string;
  fullName: string;
  workedDays: number;
  leaveDays: number;
  absentDays: number;
  workedMinutes: number;
  lateMinutes: number;
  overtimeMinutes: number;
  adjustedDays: number;
}

/** The same figures summed over everybody the filter reaches, and how many people that is. */
export interface DayTotals extends Omit<DaySummary, "employeeId" | "code" | "fullName"> {
  people: number;
}

/** One person's month in the counts their home page shows (KEHOACH 9.10). */
export interface MonthTally {
  month: string;
  workedDays: number;
  lateCount: number;
  missingPunchDays: number;
  leaveDays: number;
  absentDays: number;
}

/** Where a queued build stands; "gone" is a job the queue has already let go of. */
export type BuildState = "waiting" | "active" | "completed" | "failed" | "gone";

interface ShiftClock {
  shiftId: string;
  startMinutes: number;
  endMinutes: number;
  graceMinutes: number;
}

@Injectable()
export class TimesheetService implements OnModuleInit {
  private readonly log = new Logger(TimesheetService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly scope: ScopeService,
    private readonly config: ConfigService<Env, true>,
    private readonly audit: AuditService,
    @Inject(QUEUE_TOKEN) private readonly queues: Queues,
  ) {}

  private get zone(): string {
    return this.config.get("APP_TIMEZONE", { infer: true });
  }

  // Upserting by scheduler id: a restart re-states it, never adds a second.
  async onModuleInit(): Promise<void> {
    await this.queues[QUEUE.timesheet].upsertJobScheduler(
      kNightlyScheduler,
      { pattern: kNightlyCron, tz: this.zone },
      { name: JOB.nightly, data: { type: JOB.nightly } },
    );
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

  /** A month of a company is one row per person, so it pages by the employee
   *  code, which is unique and therefore a total order (KEHOACH 9.9 rule 3).
   */
  async summary(viewer: Viewer, query: SummaryQueryDto): Promise<Page<DaySummary>> {
    const visible = await this.scope.visibleEmployeeIds(viewer);
    const after = query.cursor ? decodeCursor(query.cursor).sortValue : null;
    const filter = this.dayFilter(query, visible);
    const [rows, found] = await Promise.all([
      this.db.$queryRaw<DaySummary[]>`
        SELECT e."id" AS "employeeId", e."code", e."fullName", ${SUMMED}
          FROM "AttendanceDay" d
          JOIN "Employee" e ON e."id" = d."employeeId"
         WHERE ${filter}
           AND (${after}::text IS NULL OR e."code" > ${after}::text)
         GROUP BY e."id", e."code", e."fullName"
         ${this.exceptionsOnly(query)}
         ORDER BY e."code"
         LIMIT ${query.take}
      `,
      this.countPeople(filter, query),
    ]);
    const last = rows[rows.length - 1];
    return {
      ...countedTo(found),
      rows,
      next: rows.length === query.take && last ? encodeCursor(last.code, last.employeeId) : null,
    };
  }

  async totals(viewer: Viewer, query: SummaryQueryDto): Promise<DayTotals> {
    const visible = await this.scope.visibleEmployeeIds(viewer);
    const filter = this.dayFilter(query, visible);
    const [summed] = await this.db.$queryRaw<DayTotals[]>`
      SELECT count(DISTINCT d."employeeId")::int AS "people", ${SUMMED}
        FROM "AttendanceDay" d
        JOIN "Employee" e ON e."id" = d."employeeId"
       WHERE ${filter}
         ${query.exceptions ? Prisma.sql`AND d."employeeId" IN (${this.exceptionPeople(filter)})` : Prisma.empty}
    `;
    return summed;
  }

  /** Every row the filter reaches as a file, not only the page on screen. */
  async summaryCsv(viewer: Viewer, query: SummaryQueryDto): Promise<string> {
    const visible = await this.scope.visibleEmployeeIds(viewer);
    const rows = await this.db.$queryRaw<(DaySummary & { department: string | null })[]>`
      SELECT e."id" AS "employeeId", e."code", e."fullName", p."name" AS "department", ${SUMMED}
        FROM "AttendanceDay" d
        JOIN "Employee" e ON e."id" = d."employeeId"
        LEFT JOIN "Department" p ON p."id" = e."departmentId"
       WHERE ${this.dayFilter(query, visible)}
       GROUP BY e."id", e."code", e."fullName", p."name"
       ${this.exceptionsOnly(query)}
       ORDER BY e."code"
    `;
    return toExcelCsv(
      [
        "code",
        "fullName",
        "department",
        "workedDays",
        "leaveDays",
        "absentDays",
        "workedMinutes",
        "lateMinutes",
        "overtimeMinutes",
        "adjustedDays",
      ],
      rows.map((row) => [
        row.code,
        row.fullName,
        row.department ?? "",
        String(row.workedDays),
        String(row.leaveDays),
        String(row.absentDays),
        String(row.workedMinutes),
        String(row.lateMinutes),
        String(row.overtimeMinutes),
        String(row.adjustedDays),
      ]),
    );
  }

  /** What a person's own month adds up to so far; today is not built yet (KEHOACH 9.8). */
  async mine(viewer: Viewer, month: string): Promise<MonthTally> {
    if (viewer.employeeId === null) {
      throw new NotFoundException("EMPLOYEE_NOT_FOUND");
    }
    const [year, index] = month.split("-").map(Number);
    const [tally] = await this.db.$queryRaw<Omit<MonthTally, "month">[]>`
      SELECT count(*) FILTER (WHERE "state" = 'WORKED')::int AS "workedDays",
             count(*) FILTER (WHERE "lateMinutes" > 0)::int  AS "lateCount",
             count(*) FILTER (WHERE "punchCount" = 1)::int   AS "missingPunchDays",
             count(*) FILTER (WHERE "state" = 'LEAVE')::int  AS "leaveDays",
             count(*) FILTER (WHERE "state" = 'ABSENT')::int AS "absentDays"
        FROM "AttendanceDay"
       WHERE "employeeId" = ${viewer.employeeId}
         AND "date" >= ${new Date(Date.UTC(year, index - 1, 1))}
         AND "date" < ${new Date(Date.UTC(year, index, 1))}
    `;
    return { month, ...tally };
  }

  private dayFilter(query: SummaryQueryDto, visible: number[] | null): Prisma.Sql {
    const term = query.search?.trim();
    return Prisma.sql`d."date" BETWEEN ${dayAsDate(query.from)} AND ${dayAsDate(query.to)}
      ${visible === null ? Prisma.empty : Prisma.sql`AND d."employeeId" = ANY(${visible}::int[])`}
      ${query.employeeId === undefined ? Prisma.empty : Prisma.sql`AND d."employeeId" = ${query.employeeId}::int`}
      ${query.departmentId ? Prisma.sql`AND e."departmentId" IN (${branchOf(query.departmentId)})` : Prisma.empty}
      ${term ? Prisma.sql`AND (e."code" ILIKE ${likeOf(term)} OR e."fullName" ILIKE ${likeOf(term)})` : Prisma.empty}`;
  }

  private exceptionsOnly(query: SummaryQueryDto): Prisma.Sql {
    return query.exceptions ? Prisma.sql`HAVING count(*) FILTER (WHERE ${EXCEPTION_DAY}) > 0` : Prisma.empty;
  }

  private exceptionPeople(filter: Prisma.Sql): Prisma.Sql {
    return Prisma.sql`
      SELECT d."employeeId"
        FROM "AttendanceDay" d
        JOIN "Employee" e ON e."id" = d."employeeId"
       WHERE ${filter} AND ${EXCEPTION_DAY}`;
  }

  private async countPeople(filter: Prisma.Sql, query: SummaryQueryDto): Promise<number> {
    const [seen] = await this.db.$queryRaw<{ found: bigint }[]>`
      SELECT count(*) AS "found" FROM (
        SELECT 1
          FROM "AttendanceDay" d
          JOIN "Employee" e ON e."id" = d."employeeId"
         WHERE ${filter}
         GROUP BY e."id"
         ${this.exceptionsOnly(query)}
         LIMIT ${COUNT_CEILING + 1}
      ) x
    `;
    return Number(seen?.found ?? 0);
  }

  /**
   * A hand correction that leaves a trace, and never overwrites what the
   * device measured (KEHOACH 9.8).
   */
  async correct(viewer: Viewer, id: string, body: CorrectDayDto): Promise<AttendanceDay> {
    // The key is (id, date) since the table is partitioned, and a caller
    // holding only an id still finds the row through the key's first column.
    const held = DAY_ID.test(id) ? await this.db.attendanceDay.findFirst({ where: { id: BigInt(id) } }) : null;
    if (!held) {
      throw new NotFoundException("DAY_NOT_FOUND");
    }
    // Nobody signs off their own timesheet (KEHOACH 9.4).
    if (held.employeeId === viewer.employeeId) {
      throw new ForbiddenException("SELF_DECISION");
    }
    if (body.workedMinutes === undefined && body.state === undefined) {
      throw new BadRequestException("NOTHING_TO_CORRECT");
    }
    const corrected = await this.db.attendanceDay.update({
      where: { id_date: { id: held.id, date: held.date } },
      data: {
        state: body.state ?? held.state,
        workedMinutes: body.workedMinutes ?? held.workedMinutes,
        measuredMinutes: held.measuredMinutes ?? held.workedMinutes,
        adjustedById: viewer.userId,
        adjustReason: body.reason,
        adjustedAt: new Date(),
      },
    });
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.TIMESHEET_CORRECT,
      subject: AUDIT_SUBJECTS.EMPLOYEE,
      subjectId: String(held.employeeId),
      meta: {
        date: held.date.toISOString().slice(0, 10),
        from: { state: held.state, workedMinutes: held.workedMinutes },
        to: { state: corrected.state, workedMinutes: corrected.workedMinutes },
      },
    });
    return corrected;
  }

  /**
   * Turn days already counted absent into what an approved request makes
   * them, for an approval that lands after the build has run. A day the
   * device saw, or a hand correction, is left alone.
   */
  markApproved(
    tx: Prisma.TransactionClient,
    employeeId: number,
    from: Date,
    to: Date,
    state: "LEAVE" | "WORKED",
  ): Promise<number> {
    return tx.$executeRaw`
      UPDATE "AttendanceDay"
         SET "state" = ${state}::"DayState", "updatedAt" = now()
       WHERE "employeeId" = ${employeeId}
         AND "date" BETWEEN ${from}::date AND ${to}::date
         AND "state" = 'ABSENT'
         AND "punchCount" = 0
         AND "adjustedById" IS NULL
    `;
  }

  /**
   * Put an approved correction on a day, creating the row when the build has
   * not reached it. The first correction keeps what the device measured in
   * `measuredMinutes`, and later ones leave that first number alone.
   */
  applyFix(
    tx: Prisma.TransactionClient,
    employeeId: number,
    date: Date,
    minutes: number,
    byUserId: string,
    reason: string,
  ): Promise<number> {
    return tx.$executeRaw`
      INSERT INTO "AttendanceDay" (
        "employeeId", "date", "state", "workedMinutes", "measuredMinutes",
        "punchCount", "adjustedById", "adjustReason", "adjustedAt", "builtAt", "updatedAt")
      VALUES (${employeeId}::int, ${date}::date, 'WORKED', ${minutes}::int, 0,
              0, ${byUserId}, ${reason}, now(), now(), now())
      ON CONFLICT ("employeeId", "date") DO UPDATE SET
        "state" = 'WORKED',
        "workedMinutes" = EXCLUDED."workedMinutes",
        "measuredMinutes" = coalesce("AttendanceDay"."measuredMinutes", "AttendanceDay"."workedMinutes"),
        "adjustedById" = EXCLUDED."adjustedById",
        "adjustReason" = EXCLUDED."adjustReason",
        "adjustedAt" = EXCLUDED."adjustedAt",
        "updatedAt" = now()
    `;
  }

  /**
   * Hand a range to the worker. A month is thirty statements over the whole
   * roster, which is minutes, and a request that long is a request that dies
   * behind the proxy rather than one that finishes.
   */
  async scheduleBuild(from: string, to: string): Promise<{ jobId: string }> {
    const job: TimesheetJob = { type: "build", from, to };
    const queued = await this.queues[QUEUE.timesheet].add(JOB.build, job);
    return { jobId: String(queued.id) };
  }

  /** Build one person's finished day again, for a punch that arrived after the day ended.
   *  @ctx any | enqueues only | a burst for one day folds into one waiting job and one follow-up
   */
  async scheduleRebuild(employeeId: number, day: string): Promise<void> {
    const job: RebuildJob = { type: JOB.rebuild, employeeId, day };
    await this.queues[QUEUE.timesheet].add(JOB.rebuild, job, {
      deduplication: { id: `rebuild-${employeeId}-${day}`, keepLastIfActive: true },
    });
  }

  /** What one queued job builds; the nightly job reads yesterday as it starts, never from its data.
   *  @ctx queue | blocking | safe to run again
   */
  async runJob(body: TimesheetJob): Promise<BuildReport> {
    if (body.type === JOB.nightly) {
      return this.buildRange(this.yesterday(), this.yesterday());
    }
    if (body.type === JOB.rebuild) {
      const rows = await this.build(body.day, body.employeeId);
      return { days: rows > 0 ? 1 : 0, rows };
    }
    return this.buildRange(body.from, body.to);
  }

  async buildState(jobId: string): Promise<{ state: BuildState }> {
    const job = await this.queues[QUEUE.timesheet].getJob(jobId);
    if (!job) {
      return { state: "gone" };
    }
    const state = await job.getState();
    if (state === "completed" || state === "failed" || state === "active") {
      return { state };
    }
    // A delayed job is waiting out a retry backoff, which is still waiting.
    return { state: state === "unknown" ? "gone" : "waiting" };
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

  yesterday(): string {
    return new Date(dayAsDate(this.today()).getTime() - kMsPerDay).toISOString().slice(0, 10);
  }

  /** The dates in a range this person is expected at work, in order, by `calendarOn`.
   *  @ctx request | reads Employee and Holiday
   */
  async workdays(employeeId: number, from: Date, to: Date): Promise<Date[]> {
    const [person, holidays] = await Promise.all([
      this.db.employee.findUnique({ where: { id: employeeId }, select: { legalEntityId: true } }),
      this.db.holiday.findMany({
        where: { date: { gte: from, lte: to } },
        select: { date: true, legalEntityId: true, paid: true },
      }),
    ]);
    const working: Date[] = [];
    for (let at = new Date(from); at <= to; at.setUTCDate(at.getUTCDate() + 1)) {
      const on = holidays.filter((one) => one.date.getTime() === at.getTime());
      if (calendarOn(at, on, person?.legalEntityId ?? null) === "WORKDAY") {
        working.push(new Date(at));
      }
    }
    return working;
  }

  /** Fold one local day's punches into one row per person, or for `only` alone.
   *  @ctx queue | blocking | safe to run again: it upserts on (employee, date)
   */
  async build(day: string, only?: number): Promise<number> {
    if (day >= this.today()) {
      // A day still in progress summarises to a wrong number (KEHOACH 9.8).
      this.log.warn(`refusing to build ${day}: it has not finished`);
      return 0;
    }
    const { from, to } = dayWindow(day, this.zone);
    const date = dayAsDate(day);
    const person = only === undefined ? {} : { employeeId: only };
    const [punches, staff, holidays, approved] = await Promise.all([
      this.db.attendanceRecord.findMany({
        where: { ts: { gte: from, lt: to }, questionableTime: false, ...person },
        select: { employeeId: true, ts: true, clockUnsynced: true },
        orderBy: { ts: "asc" },
      }),
      this.db.employee.findMany({
        // A last day is built after its record closes (KEHOACH 9.14), so `active` alone drops it.
        where: { OR: [{ active: true }, { leaveDate: { gte: date } }], ...(only === undefined ? {} : { id: only }) },
        select: { id: true, legalEntityId: true },
      }),
      this.db.holiday.findMany({ where: { date }, select: { legalEntityId: true, paid: true } }),
      this.db.request.findMany({
        // A half day cannot be one day state, so only whole days come through.
        where: {
          kind: { in: ["LEAVE", "BUSINESS_TRIP", "REMOTE_WORK"] },
          state: "APPROVED",
          halfDay: false,
          fromDate: { lte: date },
          toDate: { gte: date },
          ...person,
        },
        select: { employeeId: true, kind: true },
      }),
    ]);
    const shifts = await this.shiftsOn(date, only);

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

    const onLeave = new Set(
      approved.filter((row) => row.kind === "LEAVE").map((row) => row.employeeId),
    );
    const offSite = new Set(
      approved.filter((row) => row.kind !== "LEAVE").map((row) => row.employeeId),
    );
    const rows = staff.map((person) =>
      this.dayOf(person.id, date, seen.get(person.id), shifts.get(person.id), {
        calendar: calendarOn(date, holidays, person.legalEntityId),
        leave: onLeave.has(person.id),
        offSite: offSite.has(person.id),
      }),
    );
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
        "employeeId", "date", "state", "calendar", "shiftId", "firstIn", "lastOut",
        "workedMinutes", "lateMinutes", "earlyLeaveMinutes", "overtimeMinutes",
        "punchCount", "clockUnsynced", "measuredMinutes", "builtAt", "updatedAt")
      SELECT v."employeeId", ${date}::date, v."state"::"DayState", v."calendar"::"DayCalendar", v."shiftId",
             v."firstIn", v."lastOut", v."workedMinutes", v."lateMinutes",
             v."earlyLeaveMinutes", v."overtimeMinutes", v."punchCount",
             v."clockUnsynced", v."measuredMinutes", now(), now()
        FROM unnest(
               ${rows.map((row) => row.employeeId)}::int[],
               ${rows.map((row) => row.state)}::text[],
               ${rows.map((row) => row.calendar)}::text[],
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
             ) AS v("employeeId", "state", "calendar", "shiftId", "firstIn", "lastOut",
                    "workedMinutes", "lateMinutes", "earlyLeaveMinutes",
                    "overtimeMinutes", "punchCount", "clockUnsynced", "measuredMinutes")
        -- A person deleted since the read must not fail the whole day's write,
        -- and the share lock holds them still until this statement commits.
        JOIN "Employee" e ON e."id" = v."employeeId"
      FOR SHARE OF e
      ON CONFLICT ("employeeId", "date") DO UPDATE SET
        "state" = EXCLUDED."state",
        "calendar" = EXCLUDED."calendar",
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
        AND ("AttendanceDay"."state", "AttendanceDay"."calendar", "AttendanceDay"."shiftId",
             "AttendanceDay"."firstIn", "AttendanceDay"."lastOut", "AttendanceDay"."workedMinutes",
             "AttendanceDay"."lateMinutes", "AttendanceDay"."earlyLeaveMinutes",
             "AttendanceDay"."overtimeMinutes", "AttendanceDay"."punchCount",
             "AttendanceDay"."clockUnsynced", "AttendanceDay"."measuredMinutes")
            IS DISTINCT FROM
            (EXCLUDED."state", EXCLUDED."calendar", EXCLUDED."shiftId", EXCLUDED."firstIn",
             EXCLUDED."lastOut", EXCLUDED."workedMinutes", EXCLUDED."lateMinutes",
             EXCLUDED."earlyLeaveMinutes", EXCLUDED."overtimeMinutes", EXCLUDED."punchCount",
             EXCLUDED."clockUnsynced", EXCLUDED."measuredMinutes")
    `;
  }

  private dayOf(
    employeeId: number,
    date: Date,
    marks: { first: Date; last: Date; count: number; unsynced: boolean } | undefined,
    shift: ShiftClock | undefined,
    day: { calendar: DayCalendar; leave: boolean; offSite: boolean },
  ): DayRow {
    const { calendar } = day;
    if (!marks) {
      // A holiday belongs to everyone, so it does not spend anyone's leave.
      const state: DayState =
        calendar === "HOLIDAY" || calendar === "UNPAID_HOLIDAY"
          ? "HOLIDAY"
          : calendar === "WEEKEND"
            ? "WEEKEND"
            : day.leave
              ? "LEAVE"
              : day.offSite
                ? "WORKED"
                : "ABSENT";
      return { employeeId, date, state, calendar, shiftId: shift?.shiftId ?? null, punchCount: 0 };
    }
    const inAt = minutesIntoDay(marks.first, this.zone);
    const outAt = minutesIntoDay(marks.last, this.zone);
    const worked = Math.max(0, outAt - inAt);
    // No shift is owed on a day off, so every minute worked on one is overtime.
    const owed = calendar === "WORKDAY" ? shift : undefined;
    const late = owed ? Math.max(0, inAt - (owed.startMinutes + owed.graceMinutes)) : 0;
    const early = owed ? Math.max(0, owed.endMinutes - outAt) : 0;
    const over = owed ? Math.max(0, outAt - owed.endMinutes) : calendar === "WORKDAY" ? 0 : worked;
    return {
      employeeId,
      date,
      state: "WORKED" as DayState,
      calendar,
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

  private async shiftsOn(date: Date, only?: number): Promise<Map<number, ShiftClock>> {
    const rows = await this.db.shiftAssignment.findMany({
      where: {
        validFrom: { lte: date },
        OR: [{ validTo: null }, { validTo: { gte: date } }],
        ...(only === undefined ? {} : { employeeId: only }),
      },
      include: { shift: true },
      // Overlapping assignments resolve to the newest, since the loop keeps the last one seen.
      orderBy: [{ validFrom: "asc" }, { id: "asc" }],
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
