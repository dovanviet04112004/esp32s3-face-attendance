import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import type { Env } from "../../../config/env.schema.js";
import { PrismaService } from "../../../database/prisma.service.js";
import { QUEUE_TOKEN, type Queues } from "../../../queue/queue.module.js";
import { JOB, QUEUE } from "../../../queue/queues.js";
import { localDay } from "../../timesheet/local-day.js";
import { NoticeItemsService } from "../notice-items.service.js";
import { DUE_MARKS } from "../notice-kinds.js";

interface Due {
  contractId: string;
  employeeId: number;
  daysLeft: number;
}

const kDailyCron = "5 7 * * *";

/** A probation running out: PROBATION_DUE work for the desk and the direct manager (KEHOACH 9.18 item 2). */
@Injectable()
export class ProbationSweep implements OnModuleInit {
  private readonly log = new Logger(ProbationSweep.name);

  constructor(
    private readonly db: PrismaService,
    private readonly items: NoticeItemsService,
    private readonly config: ConfigService<Env, true>,
    @Inject(QUEUE_TOKEN) private readonly queues: Queues,
  ) {}

  // Upserting by scheduler id: a restart re-states it, never adds a second.
  async onModuleInit(): Promise<void> {
    await this.queues[QUEUE.notify].upsertJobScheduler(
      "probation-due-daily",
      { pattern: kDailyCron, tz: this.config.get("APP_TIMEZONE", { infer: true }) },
      { name: JOB.probationDue, data: { type: JOB.probationDue } },
    );
  }

  /** Close what a new contract or a leaving settled, then open and remind what ends within the first mark.
   *  @ctx job | a mark is claimed on the item, so two sweeps, or a missed day, say it once
   */
  async sweep(now: Date = new Date()): Promise<{ told: number; closed: number }> {
    const closed = await this.closeVanished();
    const today = localDay(now, this.config.get("APP_TIMEZONE", { infer: true }));
    const rows = await this.db.$queryRaw<Due[]>`
      SELECT c."id" AS "contractId", c."employeeId", (c."probationEnd" - ${today}::date)::int AS "daysLeft"
        FROM "EmploymentContract" c
        JOIN "Employee" e ON e."id" = c."employeeId"
       WHERE c."state" = 'ACTIVE' AND c."probationEnd" IS NOT NULL AND e."active" AND e."leaveDate" IS NULL
         AND (c."probationEnd" - ${today}::date) <= ${(DUE_MARKS.PROBATION_DUE ?? [0])[0]}::int
    `;
    let told = 0;
    for (const row of rows) {
      if (await this.items.speakDue("PROBATION_DUE", { id: row.contractId, employeeId: row.employeeId }, row.daysLeft)) {
        told += 1;
      }
    }
    this.log.log(`probations swept: ${told} told, ${closed} closed`);
    return { told, closed };
  }

  /** Close probation work once another contract stands, the contract is gone or ended, or the person is leaving.
   *  @ctx any | the hourly reconcile and a contract decision call it too; one UPDATE, then the rows read
   */
  async closeVanished(employeeId: number | null = null, actorId: string | null = null): Promise<number> {
    const shut = await this.db.$queryRaw<{ id: string }[]>`
      UPDATE "NoticeItem" i
         SET "state" = x."state"::"NoticeItemState", "outcome" = x."outcome"::"NoticeOutcome",
             "actorId" = ${actorId}, "closedAt" = now()::timestamp(3)
        FROM (
          SELECT n."id",
                 CASE WHEN c."id" IS NULL THEN 'EXPIRED' WHEN r."renewed" THEN 'DONE' ELSE 'CLEARED' END AS "state",
                 CASE WHEN c."id" IS NOT NULL AND r."renewed" THEN 'RENEWED' END AS "outcome"
            FROM "NoticeItem" n
            LEFT JOIN "EmploymentContract" c ON c."id" = n."subjectId"
            LEFT JOIN "Employee" e ON e."id" = c."employeeId"
            CROSS JOIN LATERAL (
              SELECT EXISTS (SELECT 1 FROM "EmploymentContract" o
                              WHERE o."employeeId" = c."employeeId" AND o."state" = 'ACTIVE' AND o."id" <> c."id") AS "renewed"
            ) r
           WHERE n."queue" = 'PROBATION_DUE' AND n."state" = 'OPEN'
             AND (${employeeId}::int IS NULL OR c."employeeId" = ${employeeId}::int)
             AND (c."id" IS NULL OR c."state" <> 'ACTIVE' OR c."probationEnd" IS NULL OR r."renewed"
                  OR NOT e."active" OR e."leaveDate" IS NOT NULL)
        ) x
       WHERE i."id" = x."id" AND i."state" = 'OPEN'
      RETURNING i."id"
    `;
    await this.items.settle(shut.map((one) => one.id));
    return shut.length;
  }
}
