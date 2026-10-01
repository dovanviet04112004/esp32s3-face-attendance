import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";

import type { Env } from "../../config/env.schema.js";
import { PrismaService } from "../../database/prisma.service.js";
import { QUEUE_TOKEN, type Queues } from "../../queue/queue.module.js";
import { JOB, QUEUE } from "../../queue/queues.js";
import { localDateSql, localDay } from "../timesheet/local-day.js";
import { NoticeItemsService } from "./notice-items.service.js";
import { NOTICE_KINDS } from "./notice-kinds.js";
import { NotificationsService } from "./notifications.service.js";

interface Waiting {
  requestId: string;
  employeeId: number;
  daysWaited: number;
}

const MARKS = NOTICE_KINDS.REQUEST_WAITING.marks;
// Eight in the morning read in APP_TIMEZONE rather than the server's UTC (KEHOACH 9.8).
const kDailyCron = "0 8 * * *";

@Injectable()
export class StaleRequestsService implements OnModuleInit {
  private readonly log = new Logger(StaleRequestsService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly notices: NotificationsService,
    private readonly items: NoticeItemsService,
    private readonly config: ConfigService<Env, true>,
    @Inject(QUEUE_TOKEN) private readonly queues: Queues,
  ) {}

  private get zone(): string {
    return this.config.get("APP_TIMEZONE", { infer: true });
  }

  // Upserting by scheduler id: a restart re-states it, never adds a second.
  async onModuleInit(): Promise<void> {
    await this.queues[QUEUE.notify].upsertJobScheduler(
      "requests-stale-daily",
      { pattern: kDailyCron, tz: this.zone },
      { name: JOB.requestsStale, data: { type: JOB.requestsStale } },
    );
  }

  /**
   * Nudge both ends of a request nobody has decided. The highest mark passed is
   * claimed on the item, so a mark is said once even after a missed day (KEHOACH 9.21.4).
   */
  async sweep(now: Date = new Date()): Promise<{ told: number }> {
    const today = localDay(now, this.zone);
    const filedOn = localDateSql(Prisma.sql`r."createdAt"`, this.zone);
    const rows = await this.db.$queryRaw<Waiting[]>`
      SELECT r."id" AS "requestId", r."employeeId", (${today}::date - ${filedOn})::int AS "daysWaited"
        FROM "Request" r
       WHERE r."state" = 'PENDING' AND (${today}::date - ${filedOn}) >= ${MARKS[0]}::int
    `;
    let told = 0;
    for (const row of rows) {
      const mark = Math.max(...MARKS.filter((one) => one <= row.daysWaited));
      if (!(await this.items.claimMark("REQUESTS", row.requestId, mark))) {
        continue;
      }
      await this.notices.raiseFor(row.employeeId, "REQUEST_STALLED", { requestId: row.requestId, daysWaited: row.daysWaited });
      await this.items.remind("REQUESTS", row.requestId, row.daysWaited);
      told += 1;
    }
    this.log.log(`stale requests swept, ${told} told of ${rows.length} past a mark`);
    return { told };
  }
}
