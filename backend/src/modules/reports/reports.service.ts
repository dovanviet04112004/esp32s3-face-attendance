import { createHash } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Queue } from "bullmq";

import { CACHE } from "../../common/cache/cache-keys.js";
import {
  COUNT_CEILING,
  countedTo,
  decodeCursor,
  encodeCursor,
} from "../../common/dto/cursor.dto.js";
import type { Page } from "../../common/dto/pagination.dto.js";
import { ScopeService } from "../../common/scope/scope.service.js";
import type { Viewer } from "../../common/scope/viewer.js";
import { toExcelCsv } from "../../common/csv.js";
import { CacheService } from "../../common/cache/cache.service.js";
import type { Env } from "../../config/env.schema.js";
import { Prisma, type LaborCategory } from "@prisma/client";

import { PrismaService } from "../../database/prisma.service.js";
import { ENDING_WINDOW_DAYS } from "../employees/dto/employee.dto.js";
import { PolicyService } from "../policy/policy.service.js";
import { TallyRangeDto } from "./dto/report.dto.js";
import { dayAsDate, dayWindow, localDay, minutesIntoDay } from "../timesheet/local-day.js";
import { branchOf, likeOf } from "../timesheet/timesheet.service.js";
import { JOB, QUEUE, type ReportJob } from "../../queue/queues.js";
import { QUEUE_TOKEN, type Queues } from "../../queue/queue.module.js";

/**
 * D02-LT is one table, not a pair of increase and decrease lists, and it runs
 * to 27 columns (Quyet dinh 1040/QD-BHXH, sua doi boi 948/QD-BHXH).
 */
const D02_COLUMNS: { at: number; head: string }[] = [
  { at: 1, head: "(1) STT" },
  { at: 2, head: "(2) Họ và tên" },
  { at: 3, head: "(3) Mã số BHXH" },
  { at: 4, head: "(4) Ngày sinh" },
  { at: 5, head: "(5) Giới tính" },
  { at: 6, head: "(6) Số CCCD/Hộ chiếu" },
  { at: 7, head: "(7) Chức danh, công việc" },
  { at: 8, head: "(8) Phân loại lao động" },
  { at: 9, head: "(9) Phân loại lao động" },
  { at: 10, head: "(10) Phân loại lao động" },
  { at: 11, head: "(11) Phân loại lao động" },
  { at: 12, head: "(12) Tiền lương" },
  { at: 13, head: "(13) Phụ cấp" },
  { at: 14, head: "(14) Phụ cấp" },
  { at: 15, head: "(15) Phụ cấp" },
  { at: 16, head: "(16) Phụ cấp" },
  { at: 17, head: "(17) Phụ cấp" },
  { at: 18, head: "(18) Nghề nặng nhọc từ" },
  { at: 19, head: "(19) Nghề nặng nhọc đến" },
  { at: 20, head: "(20) HĐLĐ không xác định thời hạn từ" },
  { at: 21, head: "(21) HĐLĐ xác định thời hạn từ" },
  { at: 22, head: "(22) HĐLĐ xác định thời hạn đến" },
  { at: 23, head: "(23) Hợp đồng khác từ" },
  { at: 24, head: "(24) Hợp đồng khác đến" },
  { at: 25, head: "(25) Bắt đầu đóng" },
  { at: 26, head: "(26) Kết thúc đóng" },
  { at: 27, head: "(27) Ghi chú" },
];

// Columns 18 and 19 date hazardous work, which nothing in this system records.
const D02_UNHELD = new Set([18, 19]);
const D02_LABOR_COLUMN: Record<LaborCategory, number> = { MANAGER: 8, HIGH_SKILLED: 9, MID_SKILLED: 10, OTHER: 11 };
const D02_MARK = "x";
const kMonthPad = 2;

const GENDER_WORD: Record<string, string> = { MALE: "Nam", FEMALE: "Nữ" };

/** Why a person's insurance standing moved this month. Codes, not sentences:
 *  the dashboard turns them into words (CLAUDE.md 3.1).
 */
export type ChangeReason = "HIRED" | "LEFT" | "UNPAID_14" | "SALARY_UP" | "SALARY_DOWN";

export interface InsuranceChange {
  employeeId: number;
  code: string;
  fullName: string;
  socialInsuranceNo: string | null;
  reason: ChangeReason;
  effectiveFrom: string;
  fromSalary: string | null;
  toSalary: string | null;
}

export interface InsuranceChanges {
  unpaidDayThreshold: number;
  increases: InsuranceChange[];
  decreases: InsuranceChange[];
  adjustments: InsuranceChange[];
}

interface MovedRow {
  employeeId: number;
  code: string;
  fullName: string;
  socialInsuranceNo: string | null;
  effectiveFrom: Date;
  fromSalary: string | null;
  toSalary: string | null;
}

interface AwayRow {
  employeeId: number;
  code: string;
  fullName: string;
  socialInsuranceNo: string | null;
  days: number;
}

const PERSON_FIELDS = {
  id: true,
  code: true,
  fullName: true,
  socialInsuranceNo: true,
  hireDate: true,
  leaveDate: true,
} as const;

interface Person {
  id: number;
  code: string;
  fullName: string;
  socialInsuranceNo: string | null;
}

function asChange(one: Person, reason: ChangeReason, on: Date): InsuranceChange {
  return {
    employeeId: one.id,
    code: one.code,
    fullName: one.fullName,
    socialInsuranceNo: one.socialInsuranceNo,
    reason,
    effectiveFrom: asDate(on),
    fromSalary: null,
    toSalary: null,
  };
}

/** No earlier record means a base registered for the first time, which is a
 *  rise from nothing rather than a cut.
 */
function wentUp(before: string | null, after: string | null): boolean {
  return BigInt(after ?? "0") >= BigInt(before ?? "0");
}

interface Fillable {
  socialInsuranceNo: string | null;
  dateOfBirth: Date | null;
  gender: string | null;
  nationalId: string | null;
  hireDate: Date | null;
  leaveDate: Date | null;
  active: boolean;
}

/** What the filing still needs, written into the row it belongs to, because a
 *  blank cell in a submitted form is found by the officer, not by anyone here.
 */
function missingFrom(one: Fillable, hasContract: boolean): string {
  const gaps: string[] = [];
  if (!one.socialInsuranceNo) {
    gaps.push("thiếu mã số BHXH");
  }
  if (!one.dateOfBirth) {
    gaps.push("thiếu ngày sinh");
  }
  if (!one.gender) {
    gaps.push("thiếu giới tính");
  }
  if (!one.nationalId) {
    gaps.push("thiếu số giấy tờ");
  }
  if (!one.hireDate) {
    gaps.push("thiếu ngày vào làm");
  }
  if (!hasContract) {
    gaps.push("chưa có hợp đồng hiệu lực");
  }
  if (!one.active && !one.leaveDate) {
    gaps.push("đã nghỉ nhưng chưa ghi ngày nghỉ");
  }
  return gaps.join("; ");
}

function asDate(value: Date | null | undefined): string {
  return value ? value.toISOString().slice(0, 10) : "";
}

/** The form wants a month, written the way the form writes one. */
function asMonth(value: Date | null | undefined): string {
  if (!value) {
    return "";
  }
  const month = String(value.getUTCMonth() + 1).padStart(kMonthPad, "0");
  return `${month}/${value.getUTCFullYear()}`;
}

/** A page of the roll-up is its own cache entry, so a reader deep in the list
 *  cannot be served the first page and a filter cannot be served unfiltered.
 */
function slotOf(from: Date, to: Date, query: TallyRangeDto): string {
  const span = `${from.toISOString()}_${to.toISOString()}`;
  return `${span}_${query.take}_${query.search ?? ""}_${query.departmentId ?? ""}_${query.late ? "late" : ""}_${query.cursor ?? ""}`;
}

/** The roll-up's own filters, the same for its rows, its count and its totals. */
function tallyFilter(visible: number[] | null, query: TallyRangeDto, zone: string): Prisma.Sql {
  const term = query.search?.trim();
  return Prisma.sql`${visible === null ? Prisma.empty : Prisma.sql`AND a."employeeId" = ANY(${visible}::int[])`}
    ${term ? Prisma.sql`AND (e."fullName" ILIKE ${likeOf(term)} OR e."code" ILIKE ${likeOf(term)})` : Prisma.empty}
    ${query.departmentId ? Prisma.sql`AND e."departmentId" IN (${branchOf(query.departmentId)})` : Prisma.empty}
    ${query.late ? Prisma.sql`AND a."employeeId" IN (${lateInRange(query, zone)})` : Prisma.empty}`;
}

/** Who came in after their shift's grace on at least one working day of the range. */
function lateInRange(query: TallyRangeDto, zone: string): Prisma.Sql {
  const local = Prisma.sql`((r."ts" AT TIME ZONE 'UTC') AT TIME ZONE ${zone})`;
  return Prisma.sql`
    SELECT r."employeeId"
      FROM "AttendanceRecord" r
      JOIN LATERAL (
        SELECT s."startTime", s."graceMinutes"
          FROM "ShiftAssignment" x
          JOIN "Shift" s ON s."id" = x."shiftId"
         WHERE x."employeeId" = r."employeeId" AND s."active" = true
           AND x."validFrom" <= ${local}::date
           AND (x."validTo" IS NULL OR x."validTo" >= ${local}::date)
         ORDER BY x."validFrom" DESC, x."id" DESC
         LIMIT 1
      ) h ON true
     WHERE r."ts" >= ${new Date(query.from)} AND r."ts" <= ${new Date(query.to)}
       AND NOT r."questionableTime"
       AND EXTRACT(ISODOW FROM ${local}) < 6
     GROUP BY r."employeeId", ${local}::date, h."startTime", h."graceMinutes"
    HAVING min(${localMinutes(Prisma.sql`r."ts"`, zone)}) > ${dueMinutes(Prisma.sql`h`)}`;
}

/** Minutes past local midnight of a stored instant; the column holds UTC without a zone. */
function localMinutes(column: Prisma.Sql, zone: string): Prisma.Sql {
  const local = Prisma.sql`((${column} AT TIME ZONE 'UTC') AT TIME ZONE ${zone})`;
  return Prisma.sql`(EXTRACT(HOUR FROM ${local}) * 60 + EXTRACT(MINUTE FROM ${local}))::int`;
}

/** Where a shift stops counting as on time, in minutes past local midnight. */
function dueMinutes(alias: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`(split_part(${alias}."startTime", ':', 1)::int * 60
    + split_part(${alias}."startTime", ':', 2)::int + ${alias}."graceMinutes")`;
}

/** One person as a home page names them. */
export interface PersonRef {
  id: number;
  code: string;
  fullName: string;
}

/** Today's four numbers, scoped to whoever asks (KEHOACH 9.10). */
export interface TodayCounts {
  date: string;
  expected: number;
  present: number;
  late: number;
  absentUnexcused: number;
  onLeave: number;
}

/** Who in a team is not where their shift says, in three short lists (KEHOACH 9.10). */
export interface TeamToday {
  absent: PersonRef[];
  onLeave: PersonRef[];
  notPunched: PersonRef[];
  totals: { absent: number; onLeave: number; notPunched: number };
}

export type TeamBucket = keyof TeamToday["totals"];

const kTeamListCap = 20;
const WEEKEND_DAYS: ReadonlySet<number> = new Set([0, 6]);

/** One employee's punches inside a range. */
export interface AttendanceTally {
  employeeId: number;
  code: string;
  fullName: string;
  punches: number;
  firstAt: string | null;
  lastAt: string | null;
  unsyncedClock: number;
}

/** The roll-up's figures summed over every person the range and the search reach. */
export interface TallyTotals {
  people: number;
  punches: number;
  unsyncedClock: number;
}

export interface Expiring {
  contractId: string;
  employeeId: number;
  code: string;
  fullName: string;
  kind: string;
  endsOn: string;
  daysLeft: number;
}

/** QUESTIONABLE_TIME carries when the server heard the punch, the hint a desk corrects it by (KEHOACH 9.8). */
export interface Exception {
  employeeId: number;
  code: string;
  fullName: string;
  reason: "NO_PUNCH" | "LATE" | "STILL_IN" | "QUESTIONABLE_TIME";
  minutes: number;
  receivedAt: Date | null;
}

/** A pile of what needs attention, and whether the count is the whole of it. */
export interface Pile<T> {
  rows: T[];
  total: number;
  totalIsExact: boolean;
}

export interface Attention {
  contractsEnding: Pile<Expiring>;
  probationEnding: Pile<Expiring>;
  exceptionsToday: Pile<Exception>;
}

/** A desk reads the first screenful, so the query asks for one row past the
 *  cap and that row becomes the word "more" rather than a silent cut.
 */
const kAttentionCap = 200;

function pileOf<T>(rows: T[]): Pile<T> {
  return rows.length > kAttentionCap
    ? { rows: rows.slice(0, kAttentionCap), total: kAttentionCap, totalIsExact: false }
    : { rows, total: rows.length, totalIsExact: true };
}

@Injectable()
export class ReportsService {
  constructor(
    private readonly db: PrismaService,
    private readonly cache: CacheService,
    private readonly scope: ScopeService,
    private readonly config: ConfigService<Env, true>,
    private readonly policy: PolicyService,
    @Inject(QUEUE_TOKEN) private readonly queues: Queues,
  ) {}

  /**
   * What HR opens in the morning. A term contract left to lapse turns
   * indefinite by law, so the horizon is a list rather than a search somebody
   * has to remember to run (KEHOACH 9.18).
   */
  async attention(now: Date = new Date()): Promise<Attention> {
    const zone = this.config.get("APP_TIMEZONE", { infer: true });
    const today = localDay(now, zone);
    const horizon = Prisma.sql`(${today}::date + ${ENDING_WINDOW_DAYS}::int)`;
    const [contracts, probation, exceptions] = await Promise.all([
      this.db.$queryRaw<Expiring[]>`
        SELECT c."id" AS "contractId", e."id" AS "employeeId", e."code", e."fullName",
               c."kind"::text, c."endDate"::text AS "endsOn",
               (c."endDate" - ${today}::date)::int AS "daysLeft"
          FROM "EmploymentContract" c
          JOIN "Employee" e ON e."id" = c."employeeId"
         WHERE c."state" = 'ACTIVE' AND e."active" = true
           AND c."endDate" IS NOT NULL AND c."endDate" <= ${horizon}
         ORDER BY c."endDate"
         LIMIT ${kAttentionCap + 1}
      `,
      this.db.$queryRaw<Expiring[]>`
        SELECT c."id" AS "contractId", e."id" AS "employeeId", e."code", e."fullName",
               c."kind"::text, c."probationEnd"::text AS "endsOn",
               (c."probationEnd" - ${today}::date)::int AS "daysLeft"
          FROM "EmploymentContract" c
          JOIN "Employee" e ON e."id" = c."employeeId"
         WHERE c."state" = 'ACTIVE' AND e."active" = true
           AND c."probationEnd" >= ${today}::date AND c."probationEnd" <= ${horizon}
         ORDER BY c."probationEnd"
         LIMIT ${kAttentionCap + 1}
      `,
      this.exceptionsOn(today, zone),
    ]);
    return {
      contractsEnding: pileOf(contracts),
      probationEnding: pileOf(probation),
      exceptionsToday: pileOf(exceptions),
    };
  }

  /**
   * Today is not in AttendanceDay, because a day still running summarises to a
   * wrong number (KEHOACH 9.8), so this reads the punches directly.
   */
  private exceptionsOn(day: string, zone: string): Promise<Exception[]> {
    return this.db.$queryRaw<Exception[]>`
      ${this.exceptionsListed(day, zone)}
      SELECT "employeeId", "code", "fullName", "reason", "minutes", "receivedAt"
        FROM listed
       ORDER BY "code"
       LIMIT ${kAttentionCap + 1}
    `;
  }

  /** Today's exceptions in full, a page at a time by code: the pile the home page caps at 200. */
  async exceptionsPage(after: string | undefined, take: number): Promise<Page<Exception>> {
    const zone = this.zone;
    const rows = await this.db.$queryRaw<(Exception & { total: number })[]>`
      ${this.exceptionsListed(localDay(new Date(), zone), zone)}
      SELECT "employeeId", "code", "fullName", "reason", "minutes", "receivedAt", "total"
        FROM listed
       WHERE true ${after ? Prisma.sql`AND "code" > ${after}` : Prisma.empty}
       ORDER BY "code"
       LIMIT ${take + 1}
    `;
    const shown = rows.slice(0, take).map(({ total: _total, ...row }) => row);
    return { rows: shown, total: rows[0]?.total ?? 0, next: rows.length > take ? (shown.at(-1)?.code ?? null) : null };
  }

  // One definition for the capped pile and the full list, so the count and the list agree.
  // A questionable punch heard today outranks what its absence makes of the day: it is the likely cause.
  private exceptionsListed(day: string, zone: string): Prisma.Sql {
    const { from, to } = dayWindow(day, zone);
    return Prisma.sql`
      ${this.todayCtes(day, zone, null, null)},
      doubted AS (
        SELECT r."employeeId", min(r."receivedAt") AS "receivedAt"
          FROM "AttendanceRecord" r
          JOIN people p ON p."id" = r."employeeId"
         WHERE r."questionableTime" AND r."receivedAt" >= ${from} AND r."receivedAt" < ${to}
         GROUP BY r."employeeId"
      ),
      missed AS (
        SELECT p."id" AS "employeeId", p."code", p."fullName",
               CASE
                 WHEN k."employeeId" IS NULL THEN 'NO_PUNCH'
                 WHEN k."marks" = 1 THEN 'STILL_IN'
                 ELSE 'LATE'
               END AS "reason",
               COALESCE(GREATEST(0, ${localMinutes(Prisma.sql`k."firstAt"`, zone)} - ${dueMinutes(Prisma.sql`x`)}), 0)::int
                 AS "minutes"
          FROM expected x
          JOIN people p ON p."id" = x."employeeId"
          LEFT JOIN seen k ON k."employeeId" = x."employeeId"
          LEFT JOIN away w ON w."employeeId" = x."employeeId"
         WHERE w."employeeId" IS NULL
           AND NOT EXISTS (SELECT 1 FROM doubted q WHERE q."employeeId" = x."employeeId")
           AND (
             k."employeeId" IS NULL
             OR k."marks" = 1
             OR ${localMinutes(Prisma.sql`k."firstAt"`, zone)} > ${dueMinutes(Prisma.sql`x`)}
           )
      ),
      listed AS (
        SELECT u.*, (count(*) OVER ())::int AS "total"
          FROM (
            SELECT m."employeeId", m."code", m."fullName", m."reason", m."minutes", NULL::timestamp AS "receivedAt"
              FROM missed m
            UNION ALL
            SELECT q."employeeId", p."code", p."fullName", 'QUESTIONABLE_TIME', 0, q."receivedAt"
              FROM doubted q
              JOIN people p ON p."id" = q."employeeId"
          ) u
      )`;
  }

  /** The people a day concerns and what they did; a weekend or an entity holiday expects nobody. */
  private todayCtes(day: string, zone: string, visible: number[] | null, leaveOut: number | null): Prisma.Sql {
    const { from, to } = dayWindow(day, zone);
    const date = dayAsDate(day);
    const weekend = WEEKEND_DAYS.has(date.getUTCDay());
    return Prisma.sql`
      WITH people AS (
        SELECT e."id", e."code", e."fullName", e."legalEntityId"
          FROM "Employee" e
         WHERE e."active" = true
           ${visible === null ? Prisma.empty : Prisma.sql`AND e."id" = ANY(${visible}::int[])`}
           ${leaveOut === null ? Prisma.empty : Prisma.sql`AND e."id" <> ${leaveOut}::int`}
      ),
      shifted AS (
        SELECT DISTINCT ON (a."employeeId") a."employeeId", s."startTime", s."graceMinutes"
          FROM "ShiftAssignment" a
          JOIN "Shift" s ON s."id" = a."shiftId"
          JOIN people p ON p."id" = a."employeeId"
         WHERE s."active" = true AND a."validFrom" <= ${date}
           AND (a."validTo" IS NULL OR a."validTo" >= ${date})
         ORDER BY a."employeeId", a."validFrom" DESC, a."id" DESC
      ),
      expected AS (
        SELECT h.*
          FROM shifted h
          JOIN people p ON p."id" = h."employeeId"
         WHERE ${weekend}::boolean = false
           AND NOT EXISTS (
             SELECT 1 FROM "Holiday" o
              WHERE o."date" = ${day}::date
                AND (o."legalEntityId" IS NULL OR o."legalEntityId" = p."legalEntityId")
           )
      ),
      seen AS (
        SELECT r."employeeId", count(*)::int AS "marks", min(r."ts") AS "firstAt"
          FROM "AttendanceRecord" r
          JOIN people p ON p."id" = r."employeeId"
         WHERE r."ts" >= ${from} AND r."ts" < ${to} AND NOT r."questionableTime"
         GROUP BY r."employeeId"
      ),
      away AS (
        SELECT q."employeeId", bool_or(q."kind" = 'LEAVE') AS "leave"
          FROM "Request" q
          JOIN people p ON p."id" = q."employeeId"
         WHERE q."state" = 'APPROVED' AND q."kind" IN ('LEAVE', 'BUSINESS_TRIP', 'REMOTE_WORK')
           AND ${day}::date BETWEEN q."fromDate" AND q."toDate"
         GROUP BY q."employeeId"
      )`;
  }

  /** Today's four numbers for the people this viewer may see; one statement. */
  async today(viewer: Viewer): Promise<TodayCounts> {
    const zone = this.config.get("APP_TIMEZONE", { infer: true });
    const day = localDay(new Date(), zone);
    const visible = await this.scope.visibleEmployeeIds(viewer);
    const [counts] = await this.db.$queryRaw<Omit<TodayCounts, "date">[]>`
      ${this.todayCtes(day, zone, visible, null)}
      SELECT (SELECT count(*) FROM expected)::int AS "expected",
             (SELECT count(*) FROM seen)::int AS "present",
             (SELECT count(*)
                FROM expected x JOIN seen k ON k."employeeId" = x."employeeId"
               WHERE ${localMinutes(Prisma.sql`k."firstAt"`, zone)} > ${dueMinutes(Prisma.sql`x`)})::int AS "late",
             (SELECT count(*)
                FROM expected x
               WHERE NOT EXISTS (SELECT 1 FROM seen k WHERE k."employeeId" = x."employeeId")
                 AND NOT EXISTS (SELECT 1 FROM away w WHERE w."employeeId" = x."employeeId"))::int AS "absentUnexcused",
             (SELECT count(*) FROM away WHERE "leave")::int AS "onLeave"
    `;
    return { date: day, ...counts };
  }

  /**
   * Who in the viewer's reach is off today, and who has not punched: absent
   * once their shift's grace has run out, not punched until then.
   */
  async teamToday(viewer: Viewer): Promise<TeamToday> {
    const rows = await this.db.$queryRaw<(PersonRef & { bucket: TeamBucket; total: number })[]>`
      ${await this.teamRanked(viewer)}
      SELECT "id", "code", "fullName", "bucket", "total"
        FROM ranked
       WHERE "at" <= ${kTeamListCap}
       ORDER BY "bucket", "code"
    `;
    const team: TeamToday = {
      absent: [],
      onLeave: [],
      notPunched: [],
      totals: { absent: 0, onLeave: 0, notPunched: 0 },
    };
    for (const row of rows) {
      team[row.bucket].push({ id: row.id, code: row.code, fullName: row.fullName });
      team.totals[row.bucket] = row.total;
    }
    return team;
  }

  /** One of today's buckets in full, a page at a time by code, for the list the home page opens. */
  async teamBucket(viewer: Viewer, bucket: TeamBucket, after: string | undefined, take: number): Promise<Page<PersonRef>> {
    const rows = await this.db.$queryRaw<(PersonRef & { total: number })[]>`
      ${await this.teamRanked(viewer)}
      SELECT "id", "code", "fullName", "total"
        FROM ranked
       WHERE "bucket" = ${bucket} ${after ? Prisma.sql`AND "code" > ${after}` : Prisma.empty}
       ORDER BY "code"
       LIMIT ${take + 1}
    `;
    const shown = rows.slice(0, take).map((row) => ({ id: row.id, code: row.code, fullName: row.fullName }));
    return { rows: shown, total: rows[0]?.total ?? 0, next: rows.length > take ? (shown.at(-1)?.code ?? null) : null };
  }

  // One definition of the buckets for the preview and the full list, so the two never disagree.
  private async teamRanked(viewer: Viewer): Promise<Prisma.Sql> {
    const zone = this.config.get("APP_TIMEZONE", { infer: true });
    const now = new Date();
    const day = localDay(now, zone);
    const visible = await this.scope.visibleEmployeeIds(viewer);
    return Prisma.sql`
      ${this.todayCtes(day, zone, visible, viewer.employeeId)},
      sorted AS (
        SELECT p."id", p."code", p."fullName",
               CASE
                 WHEN w."leave" THEN 'onLeave'
                 WHEN w."employeeId" IS NOT NULL OR k."employeeId" IS NOT NULL THEN NULL
                 WHEN ${minutesIntoDay(now, zone)}::int > ${dueMinutes(Prisma.sql`x`)} THEN 'absent'
                 ELSE 'notPunched'
               END AS "bucket"
          FROM people p
          LEFT JOIN expected x ON x."employeeId" = p."id"
          LEFT JOIN seen k ON k."employeeId" = p."id"
          LEFT JOIN away w ON w."employeeId" = p."id"
         WHERE x."employeeId" IS NOT NULL OR w."leave"
      ),
      ranked AS (
        SELECT s.*, row_number() OVER (PARTITION BY s."bucket" ORDER BY s."code") AS "at",
               (count(*) OVER (PARTITION BY s."bucket"))::int AS "total"
          FROM sorted s
         WHERE s."bucket" IS NOT NULL
      )`;
  }

  private get zone(): string {
    return this.config.get("APP_TIMEZONE", { infer: true });
  }

  /** Punches per employee between two instants; only a range already over is cached. */
  async summary(
    viewer: Viewer,
    from: Date,
    to: Date,
    query: TallyRangeDto,
  ): Promise<Page<AttendanceTally>> {
    const visible = await this.scope.visibleEmployeeIds(viewer);
    if (visible !== null && visible.length === 0) {
      return { rows: [], total: 0, next: null };
    }
    const zone = this.config.get("APP_TIMEZONE", { infer: true });
    if (to >= dayWindow(localDay(new Date(), zone), zone).from) {
      return this.page(from, to, visible, query);
    }
    const scope =
      visible === null
        ? "all"
        : createHash("sha256").update(visible.join(",")).digest("hex").slice(0, 16);
    return this.cache.through(CACHE.report("summary", slotOf(from, to, query), scope), () =>
      this.page(from, to, visible, query),
    );
  }

  /** The company-wide first page, rebuilt by the queue; no viewer means no narrowing, so only a job calls it. */
  async warm(from: Date, to: Date): Promise<Page<AttendanceTally>> {
    const query = new TallyRangeDto();
    const entry = CACHE.report("summary", slotOf(from, to, query));
    await this.cache.drop(entry.key);
    return this.cache.through(entry, () => this.page(from, to, null, query));
  }

  /** Counting is the expensive half of a page once the cursor is in place, so
   *  only the page that has a total to show pays for one (KEHOACH 9.9 rule 6).
   */
  private async page(
    from: Date,
    to: Date,
    visible: number[] | null,
    query: TallyRangeDto,
  ): Promise<Page<AttendanceTally>> {
    const rows = await this.build(from, to, visible, query);
    const last = rows[rows.length - 1];
    const next =
      rows.length === query.take && last ? encodeCursor(last.fullName, last.employeeId) : null;
    if (query.cursor) {
      return { rows, total: rows.length, next };
    }
    return { ...countedTo(await this.countTallies(from, to, visible, query)), rows, next };
  }

  private async countTallies(
    from: Date,
    to: Date,
    visible: number[] | null,
    query: TallyRangeDto,
  ): Promise<number> {
    const [seen] = await this.db.$queryRaw<{ found: bigint }[]>`
      SELECT count(*) AS "found" FROM (
        SELECT 1
        FROM "AttendanceRecord" a
        JOIN "Employee" e ON e."id" = a."employeeId"
        WHERE a."ts" >= ${from} AND a."ts" <= ${to} AND NOT a."questionableTime"
          ${tallyFilter(visible, query, this.zone)}
        GROUP BY a."employeeId", e."fullName"
        LIMIT ${COUNT_CEILING + 1}
      ) x
    `;
    return Number(seen?.found ?? 0);
  }

  async tallyTotals(viewer: Viewer, from: Date, to: Date, query: TallyRangeDto): Promise<TallyTotals> {
    const visible = await this.scope.visibleEmployeeIds(viewer);
    const [summed] = await this.db.$queryRaw<{ people: number; punches: number; unsyncedClock: number }[]>`
      SELECT count(DISTINCT a."employeeId")::int                  AS "people",
             count(*)::int                                        AS "punches",
             (count(*) FILTER (WHERE a."clockUnsynced"))::int     AS "unsyncedClock"
      FROM "AttendanceRecord" a
      JOIN "Employee" e ON e."id" = a."employeeId"
      WHERE a."ts" >= ${from} AND a."ts" <= ${to} AND NOT a."questionableTime"
        ${tallyFilter(visible, query, this.zone)}
    `;
    return summed;
  }

  /** Hand a long roll-up to the queue; it outlives the request that asked. */
  async schedule(job: ReportJob): Promise<string> {
    const queue: Queue = this.queues[QUEUE.report];
    // The range decides the id, so asking twice enqueues one run. It is hashed
    // because BullMQ refuses a colon, and an ISO instant is mostly colons.
    const id = createHash("sha256").update(`${job.type}|${job.from}|${job.to}`).digest("hex");
    // BullMQ keeps a finished job and answers a repeat id with it, so a re-ask would run nothing.
    const held = await queue.getJob(id);
    if (held && ((await held.isCompleted()) || (await held.isFailed()))) {
      await held.remove();
    }
    const queued = await queue.add(JOB.monthly, job, { jobId: id });
    return queued.id ?? "";
  }

  /** Grouped in Postgres: a month of punches does not belong in the heap. The
   *  fullName >= vale beside the pair looks redundant and is the only one that
   *  becomes an index condition (KEHOACH 9.9 rule 3).
   */
  private async build(
    from: Date,
    to: Date,
    visible: number[] | null,
    query: TallyRangeDto,
  ): Promise<AttendanceTally[]> {
    const after = query.cursor ? decodeCursor(query.cursor) : null;
    const rows = await this.db.$queryRaw<
      {
        employeeId: number;
        code: string;
        fullName: string;
        punches: bigint;
        firstAt: Date | null;
        lastAt: Date | null;
        unsyncedClock: bigint;
      }[]
    >`
      SELECT a."employeeId",
             e."code",
             e."fullName",
             count(*)                                        AS "punches",
             min(a."ts")                                     AS "firstAt",
             max(a."ts")                                     AS "lastAt",
             count(*) FILTER (WHERE a."clockUnsynced")        AS "unsyncedClock"
      FROM "AttendanceRecord" a
      JOIN "Employee" e ON e."id" = a."employeeId"
      WHERE a."ts" >= ${from} AND a."ts" <= ${to} AND NOT a."questionableTime"
        ${tallyFilter(visible, query, this.zone)}
        ${
          after
            ? Prisma.sql`AND e."fullName" >= ${after.sortValue}
          AND (e."fullName", e."id") > (${after.sortValue}, ${Number(after.id)})`
            : Prisma.empty
        }
      GROUP BY a."employeeId", e."code", e."fullName"
      ORDER BY e."fullName", a."employeeId"
      LIMIT ${query.take}
    `;
    return rows.map((row) => ({
      employeeId: row.employeeId,
      code: row.code,
      fullName: row.fullName,
      punches: Number(row.punches),
      firstAt: row.firstAt?.toISOString() ?? null,
      lastAt: row.lastAt?.toISOString() ?? null,
      unsyncedClock: Number(row.unsyncedClock),
    }));
  }

  /**
   * The roster that fills D02-LT, one row per person still on the books on the
   * closing day, as a csv the official template takes by position.
   */
  async d02(legalEntityId: string, on: Date): Promise<string> {
    const staff = await this.db.employee.findMany({
      where: {
        legalEntityId,
        AND: [
          // A missing hire date must not quietly drop somebody from a filing:
          // an empty return reads as "this company employs nobody".
          { OR: [{ hireDate: null }, { hireDate: { lte: on } }] },
          { OR: [{ leaveDate: null }, { leaveDate: { gte: on } }] },
        ],
      },
      select: {
        fullName: true,
        active: true,
        socialInsuranceNo: true,
        dateOfBirth: true,
        gender: true,
        nationalId: true,
        hireDate: true,
        leaveDate: true,
        jobTitle: { select: { name: true, laborCategory: true } },
        contracts: {
          // In force on the closing day, not in force today: a filing for June
          // asks what June looked like, and by now that term may have ended.
          where: {
            state: { in: ["ACTIVE", "ENDED"] },
            startDate: { lte: on },
            OR: [{ endDate: null }, { endDate: { gte: on } }],
          },
          orderBy: { startDate: "desc" },
          take: 1,
          select: { kind: true, startDate: true, endDate: true },
        },
        compensation: {
          where: { effectiveFrom: { lte: on } },
          orderBy: { effectiveFrom: "desc" },
          take: 1,
          select: {
            insuranceSalary: true,
            allowances: {
              where: { d02Column: { not: null } },
              select: { amount: true, d02Column: true },
            },
          },
        },
      },
      orderBy: { code: "asc" },
    });

    const rows = staff.map((one, index) => {
      const cells = new Map<number, string>();
      cells.set(1, String(index + 1));
      cells.set(2, one.fullName);
      cells.set(3, one.socialInsuranceNo ?? "");
      cells.set(4, asDate(one.dateOfBirth));
      cells.set(5, one.gender ? (GENDER_WORD[one.gender] ?? "") : "");
      cells.set(6, one.nationalId ?? "");
      cells.set(7, one.jobTitle?.name ?? "");
      if (one.jobTitle?.laborCategory) {
        cells.set(D02_LABOR_COLUMN[one.jobTitle.laborCategory], D02_MARK);
      }
      cells.set(12, one.compensation[0]?.insuranceSalary.toFixed(0) ?? "");
      const byColumn = new Map<number, bigint>();
      for (const extra of one.compensation[0]?.allowances ?? []) {
        const at = extra.d02Column as number;
        byColumn.set(at, (byColumn.get(at) ?? 0n) + BigInt(extra.amount.toFixed(0)));
      }
      for (const [at, amount] of byColumn) {
        cells.set(at, amount.toString());
      }
      const contract = one.contracts[0];
      if (contract?.kind === "INDEFINITE") {
        cells.set(20, asDate(contract.startDate));
      } else if (contract?.kind === "FIXED_TERM") {
        cells.set(21, asDate(contract.startDate));
        cells.set(22, asDate(contract.endDate));
      } else if (contract) {
        cells.set(23, asDate(contract.startDate));
        cells.set(24, asDate(contract.endDate));
      }
      cells.set(25, asMonth(one.hireDate));
      cells.set(26, asMonth(one.leaveDate));
      cells.set(27, missingFrom(one, contract !== undefined));
      return D02_COLUMNS.map((column) =>
        D02_UNHELD.has(column.at) ? "" : (cells.get(column.at) ?? ""),
      );
    });

    return toExcelCsv(
      D02_COLUMNS.map((column) => column.head),
      rows,
    );
  }

  /**
   * The three filings a month of ordinary churn owes the insurance office:
   * who started, who stopped, and whose contribution base moved.
   */
  async insuranceChanges(legalEntityId: string, from: Date, to: Date): Promise<InsuranceChanges> {
    const policy = await this.policy.effectiveAt(to, legalEntityId);
    const threshold = policy.noContributionUnpaidDays;
    const [joined, gone, moved, away] = await Promise.all([
      this.db.employee.findMany({
        where: { legalEntityId, hireDate: { gte: from, lte: to } },
        select: PERSON_FIELDS,
        orderBy: { code: "asc" },
      }),
      this.db.employee.findMany({
        where: { legalEntityId, leaveDate: { gte: from, lte: to } },
        select: PERSON_FIELDS,
        orderBy: { code: "asc" },
      }),
      this.db.$queryRaw<MovedRow[]>`
        SELECT e."id" AS "employeeId", e."code", e."fullName", e."socialInsuranceNo",
               c."effectiveFrom",
               prev."insuranceSalary"::text AS "fromSalary",
               c."insuranceSalary"::text    AS "toSalary"
          FROM "CompensationRecord" c
          JOIN "Employee" e ON e."id" = c."employeeId"
          LEFT JOIN LATERAL (
            SELECT p."insuranceSalary"
              FROM "CompensationRecord" p
             WHERE p."employeeId" = c."employeeId"
               AND p."effectiveFrom" < c."effectiveFrom"
             ORDER BY p."effectiveFrom" DESC
             LIMIT 1
          ) prev ON true
         WHERE e."legalEntityId" = ${legalEntityId}
           AND c."effectiveFrom" BETWEEN ${from}::date AND ${to}::date
           AND prev."insuranceSalary" IS DISTINCT FROM c."insuranceSalary"
         ORDER BY c."effectiveFrom", e."code"
      `,
      this.db.$queryRaw<AwayRow[]>`
        SELECT e."id" AS "employeeId", e."code", e."fullName", e."socialInsuranceNo",
               count(*)::int AS "days"
          FROM "AttendanceDay" d
          JOIN "Employee" e ON e."id" = d."employeeId"
          LEFT JOIN LATERAL (
            SELECT t."paid"
              FROM "Request" r
              JOIN "LeaveType" t ON t."id" = r."leaveTypeId"
             WHERE r."employeeId" = d."employeeId"
               AND r."kind" = 'LEAVE' AND r."state" = 'APPROVED'
               AND d."date" BETWEEN r."fromDate" AND r."toDate"
             LIMIT 1
          ) lt ON true
         WHERE e."legalEntityId" = ${legalEntityId}
           AND d."date" BETWEEN ${from}::date AND ${to}::date
           AND (d."state" = 'ABSENT' OR (d."state" = 'LEAVE' AND lt."paid" IS NOT TRUE))
         GROUP BY e."id", e."code", e."fullName", e."socialInsuranceNo"
        HAVING count(*) >= ${threshold}
         ORDER BY e."code"
      `,
    ]);

    const newly = new Set(joined.map((one) => one.id));
    const increases = joined.map((one) => asChange(one, "HIRED", one.hireDate as Date));
    const decreases = [
      ...gone.map((one) => asChange(one, "LEFT", one.leaveDate as Date)),
      // Fourteen unpaid days stops the contribution for the month, the same
      // rule the payslip applies (KEHOACH 9.7).
      ...away.map((one) => asChange({ ...one, id: one.employeeId }, "UNPAID_14", to)),
    ];
    const adjustments = moved
      .filter((row) => !newly.has(row.employeeId))
      .map((row) => ({
        employeeId: row.employeeId,
        code: row.code,
        fullName: row.fullName,
        socialInsuranceNo: row.socialInsuranceNo,
        reason: wentUp(row.fromSalary, row.toSalary) ? ("SALARY_UP" as const) : ("SALARY_DOWN" as const),
        effectiveFrom: asDate(row.effectiveFrom),
        fromSalary: row.fromSalary,
        toSalary: row.toSalary,
      }));
    return { unpaidDayThreshold: threshold, increases, decreases, adjustments };
  }
}
