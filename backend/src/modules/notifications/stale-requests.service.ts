import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";

import type { Env } from "../../config/env.schema.js";
import { PrismaService } from "../../database/prisma.service.js";
import { QUEUE_TOKEN, type Queues } from "../../queue/queue.module.js";
import { JOB, QUEUE } from "../../queue/queues.js";
import { LeaveService } from "../leave/leave.service.js";
import { localDateSql, localDay } from "../timesheet/local-day.js";
import { NotificationsService } from "./notifications.service.js";

interface Waiting {
  requestId: string;
  employeeId: number;
  approverId: number | null;
  daysWaited: number;
}

// The marks section 9.17 item 12 asks for. Daily is what people switch off.
const MARKS = [3, 7, 14];
// Eight in the morning read in APP_TIMEZONE rather than the server's UTC (KEHOACH 9.8).
const kDailyCron = "0 8 * * *";

@Injectable()
export class StaleRequestsService implements OnModuleInit {
  private readonly log = new Logger(StaleRequestsService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly notices: NotificationsService,
    private readonly leave: LeaveService,
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
   * Nudge both ends of a request nobody has decided. The notice already raised
   * for that mark is the record, so a mark is spoken once (KEHOACH 9.17.12).
   */
  async sweep(now: Date = new Date()): Promise<{ told: number }> {
    const today = localDay(now, this.zone);
    const filedOn = localDateSql(Prisma.sql`r."createdAt"`, this.zone);
    const rows = await this.db.$queryRaw<Waiting[]>`
      SELECT r."id" AS "requestId", r."employeeId", r."approverId",
             (${today}::date - ${filedOn})::int AS "daysWaited"
        FROM "Request" r
       WHERE r."state" = 'PENDING'
         AND (${today}::date - ${filedOn}) = ANY(${MARKS}::int[])
    `;
    let told = 0;
    for (const row of rows) {
      const already = await this.db.notification.findFirst({
        where: {
          kind: "REQUEST_STALLED",
          requestId: row.requestId,
          daysWaited: row.daysWaited,
        },
        select: { id: true },
      });
      if (already) {
        continue;
      }
      const facts = { requestId: row.requestId, daysWaited: row.daysWaited };
      await this.notices.raiseFor(row.employeeId, "REQUEST_STALLED", facts);
      // An unclaimed request nudges the desk holding it (KEHOACH 9.15).
      if (row.approverId === null) {
        await this.notices.raiseMany(await this.leave.deskIds(row.employeeId), "REQUEST_WAITING", facts);
      } else {
        await this.notices.raiseFor(row.approverId, "REQUEST_WAITING", facts);
      }
      told += 1;
    }
    this.log.log(`stale requests swept, ${told} told of ${rows.length} at a mark`);
    return { told };
  }
}
