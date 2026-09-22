import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";

import { PrismaService } from "../../database/prisma.service.js";
import { QUEUE_TOKEN, type Queues } from "../../queue/queue.module.js";
import { QUEUE } from "../../queue/queues.js";
import { LeaveService } from "../leave/leave.service.js";
import { NotificationsService } from "./notifications.service.js";

interface Waiting {
  requestId: string;
  employeeId: number;
  approverId: number | null;
  daysWaited: number;
}

// The marks section 9.17 item 12 asks for. Daily is what people switch off.
const MARKS = [3, 7, 14];
const kDailyCron = "0 8 * * *";

@Injectable()
export class StaleRequestsService implements OnModuleInit {
  private readonly log = new Logger(StaleRequestsService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly notices: NotificationsService,
    private readonly leave: LeaveService,
    @Inject(QUEUE_TOKEN) private readonly queues: Queues,
  ) {}

  // Upserting by scheduler id: a restart re-states it, never adds a second.
  async onModuleInit(): Promise<void> {
    await this.queues[QUEUE.notify].upsertJobScheduler(
      "requests-stale-daily",
      { pattern: kDailyCron },
      { name: "requests-stale", data: { type: "requests-stale" } },
    );
  }

  /**
   * Nudge both ends of a request nobody has decided. The notice already raised
   * for that mark is the record, so a mark is spoken once (KEHOACH 9.17.12).
   */
  async sweep(): Promise<{ told: number }> {
    const rows = await this.db.$queryRaw<Waiting[]>`
      SELECT r."id" AS "requestId", r."employeeId", r."approverId",
             (CURRENT_DATE - r."createdAt"::date)::int AS "daysWaited"
        FROM "Request" r
       WHERE r."state" = 'PENDING'
         AND (CURRENT_DATE - r."createdAt"::date) = ANY(${MARKS}::int[])
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
