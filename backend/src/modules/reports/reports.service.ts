import { createHash } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Queue } from "bullmq";

import { CACHE } from "../../common/cache/cache-keys.js";
import { CacheService } from "../../common/cache/cache.service.js";
import type { Env } from "../../config/env.schema.js";
import { PrismaService } from "../../database/prisma.service.js";
import { toCsv } from "../payroll/payroll.service.js";
import { dayWindow, localDay } from "../timesheet/local-day.js";
import { QUEUE, type ReportJob } from "../../queue/queues.js";
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

// Columns 8 to 11 and 18 to 19 describe labour categories and hazardous work
// that nothing in this system records, so they go out empty.
const D02_UNHELD = new Set([8, 9, 10, 11, 18, 19]);
// Excel reads a csv as the local code page unless this says otherwise, and
// every Vietnamese name in the file turns to mojibake when it does.
const kByteOrderMark = "\ufeff";
const kAllowanceColumns = 5;
const kMonthPad = 2;

const GENDER_WORD: Record<string, string> = { MALE: "Nam", FEMALE: "Nữ" };

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

/** One employee's punches inside a range. */
export interface AttendanceTally {
  employeeId: number;
  fullName: string;
  punches: number;
  firstAt: string | null;
  lastAt: string | null;
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

export interface Exception {
  employeeId: number;
  code: string;
  fullName: string;
  reason: "NO_PUNCH" | "LATE" | "STILL_IN";
  minutes: number;
}

export interface Attention {
  contractsEnding: Expiring[];
  probationEnding: Expiring[];
  exceptionsToday: Exception[];
}

const kHorizonDays = 30;
const kMsPerDay = 86_400_000;

@Injectable()
export class ReportsService {
  constructor(
    private readonly db: PrismaService,
    private readonly cache: CacheService,
    private readonly config: ConfigService<Env, true>,
    @Inject(QUEUE_TOKEN) private readonly queues: Queues,
  ) {}

  /**
   * What HR opens in the morning. A term contract left to lapse turns
   * indefinite by law, so the horizon is a list rather than a search somebody
   * has to remember to run (KEHOACH 9.18).
   */
  async attention(): Promise<Attention> {
    const zone = this.config.get("APP_TIMEZONE", { infer: true });
    const today = localDay(new Date(), zone);
    const horizon = new Date(Date.now() + kHorizonDays * kMsPerDay);
    const [contracts, probation, exceptions] = await Promise.all([
      this.db.$queryRaw<Expiring[]>`
        SELECT c."id" AS "contractId", e."id" AS "employeeId", e."code", e."fullName",
               c."kind"::text, c."endDate"::text AS "endsOn",
               (c."endDate"::date - CURRENT_DATE)::int AS "daysLeft"
          FROM "EmploymentContract" c
          JOIN "Employee" e ON e."id" = c."employeeId"
         WHERE c."state" = 'ACTIVE' AND e."active" = true
           AND c."endDate" IS NOT NULL AND c."endDate" <= ${horizon}
         ORDER BY c."endDate"
         LIMIT 200
      `,
      this.db.$queryRaw<Expiring[]>`
        SELECT c."id" AS "contractId", e."id" AS "employeeId", e."code", e."fullName",
               c."kind"::text, c."probationEnd"::text AS "endsOn",
               (c."probationEnd"::date - CURRENT_DATE)::int AS "daysLeft"
          FROM "EmploymentContract" c
          JOIN "Employee" e ON e."id" = c."employeeId"
         WHERE c."state" = 'ACTIVE' AND e."active" = true
           AND c."probationEnd" IS NOT NULL AND c."probationEnd" <= ${horizon}
         ORDER BY c."probationEnd"
         LIMIT 200
      `,
      this.exceptionsOn(today, zone),
    ]);
    return { contractsEnding: contracts, probationEnding: probation, exceptionsToday: exceptions };
  }

  /**
   * Today is not in AttendanceDay, because a day still running summarises to a
   * wrong number (KEHOACH 9.8), so this reads the punches directly.
   */
  private exceptionsOn(day: string, zone: string): Promise<Exception[]> {
    const { from, to } = dayWindow(day, zone);
    return this.db.$queryRaw<Exception[]>`
      WITH shifted AS (
        SELECT a."employeeId", s."startTime", s."graceMinutes"
          FROM "ShiftAssignment" a
          JOIN "Shift" s ON s."id" = a."shiftId"
         WHERE s."active" = true AND a."validFrom" <= ${from}
           AND (a."validTo" IS NULL OR a."validTo" >= ${from})
      ),
      seen AS (
        SELECT "employeeId", count(*)::int AS marks, min("ts") AS "firstAt"
          FROM "AttendanceRecord"
         WHERE "ts" >= ${from} AND "ts" < ${to}
         GROUP BY "employeeId"
      ),
      off AS (
        SELECT DISTINCT "employeeId" FROM "Request"
         WHERE "state" = 'APPROVED' AND "kind" IN ('LEAVE', 'BUSINESS_TRIP', 'REMOTE_WORK')
           AND ${from}::date BETWEEN "fromDate" AND "toDate"
      )
      SELECT e."id" AS "employeeId", e."code", e."fullName",
             CASE
               WHEN k."employeeId" IS NULL THEN 'NO_PUNCH'
               WHEN k.marks = 1 THEN 'STILL_IN'
               ELSE 'LATE'
             END AS "reason",
             COALESCE(
               GREATEST(
                 0,
                 (EXTRACT(EPOCH FROM (k."firstAt" AT TIME ZONE ${zone}))::int % 86400) / 60
                   - (split_part(h."startTime", ':', 1)::int * 60
                      + split_part(h."startTime", ':', 2)::int + h."graceMinutes")
               ),
               0
             )::int AS "minutes"
        FROM "Employee" e
        JOIN shifted h ON h."employeeId" = e."id"
        LEFT JOIN seen k ON k."employeeId" = e."id"
        LEFT JOIN off o ON o."employeeId" = e."id"
       WHERE e."active" = true AND o."employeeId" IS NULL
         AND (
           k."employeeId" IS NULL
           OR k.marks = 1
           OR (EXTRACT(EPOCH FROM (k."firstAt" AT TIME ZONE ${zone}))::int % 86400) / 60
              > split_part(h."startTime", ':', 1)::int * 60
                + split_part(h."startTime", ':', 2)::int + h."graceMinutes"
         )
       ORDER BY e."code"
       LIMIT 200
    `;
  }

  /** Punches per employee between two instants, cached for a quarter hour. */
  summary(from: Date, to: Date): Promise<AttendanceTally[]> {
    const range = `${from.toISOString()}_${to.toISOString()}`;
    return this.cache.through(CACHE.report("summary", range), () => this.build(from, to));
  }

  /** Hand a long roll-up to the queue; it outlives the request that asked. */
  async schedule(job: ReportJob): Promise<string> {
    const queue: Queue = this.queues[QUEUE.report];
    // The range decides the id, so asking twice enqueues one run. It is hashed
    // because BullMQ refuses a colon, and an ISO instant is mostly colons.
    const id = createHash("sha256").update(`${job.type}|${job.from}|${job.to}`).digest("hex");
    const queued = await queue.add(QUEUE.report, job, { jobId: id });
    return queued.id ?? "";
  }

  /** Grouped in Postgres: a month of punches does not belong in the heap. */
  private async build(from: Date, to: Date): Promise<AttendanceTally[]> {
    const rows = await this.db.$queryRaw<
      {
        employeeId: number;
        fullName: string;
        punches: bigint;
        firstAt: Date | null;
        lastAt: Date | null;
        unsyncedClock: bigint;
      }[]
    >`
      SELECT a."employeeId",
             e."fullName",
             count(*)                                        AS "punches",
             min(a."ts")                                     AS "firstAt",
             max(a."ts")                                     AS "lastAt",
             count(*) FILTER (WHERE a."clockUnsynced")        AS "unsyncedClock"
      FROM "AttendanceRecord" a
      JOIN "Employee" e ON e."id" = a."employeeId"
      WHERE a."ts" >= ${from} AND a."ts" <= ${to}
      GROUP BY a."employeeId", e."fullName"
      ORDER BY e."fullName"
    `;
    return rows.map((row) => ({
      employeeId: row.employeeId,
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
        jobTitle: { select: { name: true } },
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
              where: { insurable: true },
              orderBy: { code: "asc" },
              select: { amount: true },
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
      cells.set(12, one.compensation[0]?.insuranceSalary.toFixed(0) ?? "");
      const extras = one.compensation[0]?.allowances ?? [];
      for (let slot = 0; slot < kAllowanceColumns; slot += 1) {
        cells.set(13 + slot, extras[slot]?.amount.toFixed(0) ?? "");
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

    return (
      kByteOrderMark +
      toCsv(
        D02_COLUMNS.map((column) => column.head),
        rows,
      )
    );
  }
}
