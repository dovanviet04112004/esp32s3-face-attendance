import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";

import type { Env } from "../../config/env.schema.js";
import { PrismaService } from "../../database/prisma.service.js";
import { QUEUE_TOKEN, type Queues } from "../../queue/queue.module.js";
import { JOB, QUEUE } from "../../queue/queues.js";
import { localDay } from "../timesheet/local-day.js";

// Five past midnight on 1 January, read in APP_TIMEZONE rather than the server's UTC (KEHOACH 9.8).
const kNewYearCron = "5 0 1 1 *";
const kSchedulerId = "leave-year-open";

export interface BalanceKey {
  employeeId: number;
  leaveTypeId: string;
}

export interface OpenedYear {
  year: number;
  created: number;
  carried: number;
}

/** What a full year of a type earns in `year`, prorated in the hire year (KEHOACH 9.14); reads `e` and `t`. */
function entitledIn(year: number): Prisma.Sql {
  return Prisma.sql`CASE
      WHEN e."hireDate" IS NULL OR e."hireDate" < make_date(${year}::int, 1, 1) THEN t."daysPerYear"
      WHEN e."hireDate" >= make_date(${year}::int + 1, 1, 1) THEN 0
      ELSE round(t."daysPerYear" * (make_date(${year}::int + 1, 1, 1) - e."hireDate")
                 / (make_date(${year}::int + 1, 1, 1) - make_date(${year}::int, 1, 1)) * 2) / 2
    END`;
}

@Injectable()
export class LeaveYearService implements OnModuleInit {
  private readonly log = new Logger(LeaveYearService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly config: ConfigService<Env, true>,
    @Inject(QUEUE_TOKEN) private readonly queues: Queues,
  ) {}

  private get zone(): string {
    return this.config.get("APP_TIMEZONE", { infer: true });
  }

  async onModuleInit(): Promise<void> {
    await this.queues[QUEUE.leave].upsertJobScheduler(
      kSchedulerId,
      { pattern: kNewYearCron, tz: this.zone },
      { name: JOB.leaveYear, data: { type: JOB.leaveYear } },
    );
  }

  thisYear(): number {
    return Number(localDay(new Date(), this.zone).slice(0, 4));
  }

  /** Every working person's rows for `year`, then the carry-over out of `year - 1`.
   *  @ctx queue | one transaction | safe to run again: rows exist once and a year closes once
   */
  async open(year: number): Promise<OpenedYear> {
    const [created, carried] = await this.db.$transaction([
      this.db.$executeRaw(this.rowsFor(year, null)),
      this.db.$executeRaw(this.carryInto(year, null)),
    ]);
    this.log.log(`opened ${year}: ${created} row(s) made, ${carried} carried over`);
    return { year, created, carried };
  }

  /** A row for this key and year inside the filing's transaction; a year already begun closes `year - 1` too.
   *  @ctx request | inside tx | no-op when the row exists
   */
  async ensure(tx: Prisma.TransactionClient, key: BalanceKey, year: number): Promise<void> {
    const created = await tx.$executeRaw(this.rowsFor(year, key));
    if (created === 1 && year <= this.thisYear()) {
      await tx.$executeRaw(this.carryInto(year, key));
    }
  }

  /** What a row for this key and year would open with, for a year that has none yet. */
  async projected(key: BalanceKey, year: number): Promise<number> {
    const [row] = await this.db.$queryRaw<{ entitled: Prisma.Decimal | null }[]>`
      SELECT ${entitledIn(year)} AS "entitled"
        FROM "Employee" e, "LeaveType" t
       WHERE e."id" = ${key.employeeId} AND t."id" = ${key.leaveTypeId}
    `;
    return Number(row?.entitled ?? 0);
  }

  private rowsFor(year: number, key: BalanceKey | null): Prisma.Sql {
    const whose = key
      ? Prisma.sql`e."id" = ${key.employeeId} AND t."id" = ${key.leaveTypeId}`
      : Prisma.sql`t."active" AND (e."active" OR e."leaveDate" >= make_date(${year}::int, 1, 1))`;
    return Prisma.sql`
      INSERT INTO "LeaveBalance" ("id", "employeeId", "leaveTypeId", "year", "entitled", "updatedAt")
      SELECT gen_random_uuid()::text, e."id", t."id", ${year}::int, ${entitledIn(year)}, now()
        FROM "Employee" e
       CROSS JOIN "LeaveType" t
       WHERE ${whose}
      ON CONFLICT ("employeeId", "leaveTypeId", "year") DO NOTHING
    `;
  }

  // Waiting requests count as spent: what they hold is not free to carry (KEHOACH 9.5).
  private carryInto(year: number, key: BalanceKey | null): Prisma.Sql {
    const whose = key
      ? Prisma.sql`AND o."employeeId" = ${key.employeeId} AND o."leaveTypeId" = ${key.leaveTypeId}`
      : Prisma.empty;
    return Prisma.sql`
      WITH closed AS (
        UPDATE "LeaveBalance" o
           SET "carriedOut" = LEAST(t."carryOverMax",
                                    GREATEST(0, o."entitled" + o."carriedOver" - o."taken" - o."pending")),
               "closedAt" = now(), "updatedAt" = now()
          FROM "LeaveType" t
         WHERE t."id" = o."leaveTypeId"
           AND o."year" = ${year - 1}::int
           AND o."closedAt" IS NULL
           AND EXISTS (
             SELECT 1 FROM "LeaveBalance" n
              WHERE n."employeeId" = o."employeeId" AND n."leaveTypeId" = o."leaveTypeId"
                AND n."year" = ${year}::int
           )
           ${whose}
        RETURNING o."employeeId", o."leaveTypeId", o."carriedOut"
      )
      UPDATE "LeaveBalance" n
         SET "carriedOver" = n."carriedOver" + c."carriedOut", "updatedAt" = now()
        FROM closed c
       WHERE n."employeeId" = c."employeeId" AND n."leaveTypeId" = c."leaveTypeId"
         AND n."year" = ${year}::int
    `;
  }
}
