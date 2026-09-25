import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import type { Env } from "../../config/env.schema.js";
import { PrismaService } from "../../database/prisma.service.js";
import { QUEUE_TOKEN, type Queues } from "../../queue/queue.module.js";
import { JOB, QUEUE } from "../../queue/queues.js";
import { localDay } from "../timesheet/local-day.js";
import { NotificationsService } from "./notifications.service.js";

interface Ending {
  employeeId: number;
  contractId: string;
  daysLeft: number;
}

// The marks section 9.18 asks for. A contract crosses each one exactly once.
const MARKS = [30, 15, 7];
// Seven in the morning read in APP_TIMEZONE rather than the server's UTC (KEHOACH 9.8).
const kDailyCron = "0 7 * * *";

@Injectable()
export class ContractAlertsService implements OnModuleInit {
  private readonly log = new Logger(ContractAlertsService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly notices: NotificationsService,
    private readonly config: ConfigService<Env, true>,
    @Inject(QUEUE_TOKEN) private readonly queues: Queues,
  ) {}

  private get zone(): string {
    return this.config.get("APP_TIMEZONE", { infer: true });
  }

  // Upserting by scheduler id: a restart re-states it, never adds a second.
  async onModuleInit(): Promise<void> {
    await this.queues[QUEUE.notify].upsertJobScheduler(
      "contracts-ending-daily",
      { pattern: kDailyCron, tz: this.zone },
      { name: JOB.contractsEnding, data: { type: JOB.contractsEnding } },
    );
  }

  /**
   * Tell people whose contract crosses a mark today. The same mark never
   * tells twice, because an existing notice for that pair is the record.
   */
  async sweep(now: Date = new Date()): Promise<{ told: number }> {
    const today = localDay(now, this.zone);
    const rows = await this.db.$queryRaw<Ending[]>`
      SELECT c."employeeId", c."id" AS "contractId",
             (c."endDate" - ${today}::date)::int AS "daysLeft"
        FROM "EmploymentContract" c
        JOIN "Employee" e ON e."id" = c."employeeId"
       WHERE c."state" = 'ACTIVE' AND e."active" = true AND c."endDate" IS NOT NULL
         AND (c."endDate" - ${today}::date) = ANY(${MARKS}::int[])
    `;
    let told = 0;
    for (const row of rows) {
      const already = await this.db.notification.findFirst({
        where: { kind: "CONTRACT_ENDING", contractId: row.contractId, daysLeft: row.daysLeft },
        select: { id: true },
      });
      if (already) {
        continue;
      }
      await this.notices.raiseFor(row.employeeId, "CONTRACT_ENDING", {
        contractId: row.contractId,
        daysLeft: row.daysLeft,
      });
      told += 1;
    }
    this.log.log(`contract marks swept, ${told} told of ${rows.length} at a mark`);
    return { told };
  }
}
