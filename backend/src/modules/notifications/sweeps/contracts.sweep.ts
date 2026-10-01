import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import type { Env } from "../../../config/env.schema.js";
import { PrismaService } from "../../../database/prisma.service.js";
import { QUEUE_TOKEN, type Queues } from "../../../queue/queue.module.js";
import { JOB, QUEUE } from "../../../queue/queues.js";
import { localDay } from "../../timesheet/local-day.js";
import { NoticeItemsService } from "../notice-items.service.js";
import { DUE_MARKS } from "../notice-kinds.js";
import { NotificationsService } from "../notifications.service.js";

interface Due {
  contractId: string;
  employeeId: number;
  daysLeft: number;
}

// Seven in the morning read in APP_TIMEZONE rather than the server's UTC (KEHOACH 9.8).
const kDailyCron = "0 7 * * *";

/** A contract with an end date running out: the desk's CONTRACT_DUE work, and the signer's own notice (KEHOACH 9.18 item 1). */
@Injectable()
export class ContractsSweep implements OnModuleInit {
  private readonly log = new Logger(ContractsSweep.name);

  constructor(
    private readonly db: PrismaService,
    private readonly notices: NotificationsService,
    private readonly items: NoticeItemsService,
    private readonly config: ConfigService<Env, true>,
    @Inject(QUEUE_TOKEN) private readonly queues: Queues,
  ) {}

  // Upserting by scheduler id: a restart re-states it, never adds a second.
  async onModuleInit(): Promise<void> {
    await this.queues[QUEUE.notify].upsertJobScheduler(
      "contracts-ending-daily",
      { pattern: kDailyCron, tz: this.config.get("APP_TIMEZONE", { infer: true }) },
      { name: JOB.contractsEnding, data: { type: JOB.contractsEnding } },
    );
  }

  /** Close what renewed or ended, then open and remind what runs out within the first mark.
   *  @ctx job | a mark is claimed on the item, so two sweeps, or a missed day, say it once
   */
  async sweep(now: Date = new Date()): Promise<{ told: number; closed: number }> {
    const closed = await this.closeVanished();
    const today = localDay(now, this.config.get("APP_TIMEZONE", { infer: true }));
    const rows = await this.db.$queryRaw<Due[]>`
      SELECT c."id" AS "contractId", c."employeeId", (c."endDate" - ${today}::date)::int AS "daysLeft"
        FROM "EmploymentContract" c
        JOIN "Employee" e ON e."id" = c."employeeId"
       WHERE c."state" = 'ACTIVE' AND c."endDate" IS NOT NULL AND e."active" AND e."leaveDate" IS NULL
         AND (c."endDate" - ${today}::date) <= ${(DUE_MARKS.CONTRACTS_DUE ?? [0])[0]}::int
    `;
    let told = 0;
    for (const row of rows) {
      if (await this.items.speakDue("CONTRACTS_DUE", { id: row.contractId, employeeId: row.employeeId }, row.daysLeft)) {
        await this.notices.raiseFor(row.employeeId, "CONTRACT_ENDING", { contractId: row.contractId, daysLeft: row.daysLeft });
        told += 1;
      }
    }
    this.log.log(`contracts swept: ${told} told, ${closed} closed`);
    return { told, closed };
  }

  /** Close contract work whose contract is renewed, ended or gone, or whose signer is leaving.
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
           WHERE n."queue" = 'CONTRACTS_DUE' AND n."state" = 'OPEN'
             AND (${employeeId}::int IS NULL OR c."employeeId" = ${employeeId}::int)
             AND (c."id" IS NULL OR c."state" <> 'ACTIVE' OR c."endDate" IS NULL OR r."renewed"
                  OR NOT e."active" OR e."leaveDate" IS NOT NULL)
        ) x
       WHERE i."id" = x."id" AND i."state" = 'OPEN'
      RETURNING i."id"
    `;
    await this.items.settle(shut.map((one) => one.id));
    return shut.length;
  }
}
