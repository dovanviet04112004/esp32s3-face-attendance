import { createHash } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Queue } from "bullmq";

import { CACHE } from "../../common/cache/cache-keys.js";
import { CacheService } from "../../common/cache/cache.service.js";
import type { Env } from "../../config/env.schema.js";
import { PrismaService } from "../../database/prisma.service.js";
import { dayWindow, localDay } from "../timesheet/local-day.js";
import { QUEUE, type ReportJob } from "../../queue/queues.js";
import { QUEUE_TOKEN, type Queues } from "../../queue/queue.module.js";

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
}
