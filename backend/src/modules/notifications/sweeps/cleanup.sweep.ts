import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import type { Env } from "../../../config/env.schema.js";
import { PrismaService } from "../../../database/prisma.service.js";
import { QUEUE_TOKEN, type Queues } from "../../../queue/queue.module.js";
import { JOB, QUEUE } from "../../../queue/queues.js";

// Twenty to three in the morning in APP_TIMEZONE, clear of the 00:30 day build (KEHOACH 9.8).
const kNightlyCron = "40 2 * * *";
const kBatch = 5000;
const kDayMs = 86_400_000;

/** Drops what the bell has stopped needing: news long read, and work long closed with its rows (KEHOACH 9.21.4). */
@Injectable()
export class CleanupSweep implements OnModuleInit {
  private readonly log = new Logger(CleanupSweep.name);

  constructor(
    private readonly db: PrismaService,
    private readonly config: ConfigService<Env, true>,
    @Inject(QUEUE_TOKEN) private readonly queues: Queues,
  ) {}

  // Upserting by scheduler id: a restart re-states it, never adds a second.
  async onModuleInit(): Promise<void> {
    await this.queues[QUEUE.notify].upsertJobScheduler(
      "notice-cleanup-nightly",
      { pattern: kNightlyCron, tz: this.config.get("APP_TIMEZONE", { infer: true }) },
      { name: JOB.noticeCleanup, data: { type: JOB.noticeCleanup } },
    );
  }

  /** Delete in batches news read, and work closed, NOTICE_KEEP_DAYS ago; open work is never touched.
   *  @ctx job | one bounded DELETE at a time, so the bell's table is never locked for long
   */
  async sweep(now: Date = new Date()): Promise<{ items: number; rows: number }> {
    const cutoff = new Date(now.getTime() - this.config.get("NOTICE_KEEP_DAYS", { infer: true }) * kDayMs);
    let items = 0;
    for (;;) {
      const gone = await this.db.$executeRaw`
        DELETE FROM "NoticeItem" WHERE "id" IN (
          SELECT "id" FROM "NoticeItem" WHERE "state" <> 'OPEN' AND "closedAt" < ${cutoff} LIMIT ${kBatch}
        )
      `;
      items += gone;
      if (gone < kBatch) {
        break;
      }
    }
    let rows = 0;
    for (;;) {
      const gone = await this.db.$executeRaw`
        DELETE FROM "Notification" WHERE "id" IN (
          SELECT "id" FROM "Notification" WHERE "itemId" IS NULL AND "readAt" < ${cutoff} LIMIT ${kBatch}
        )
      `;
      rows += gone;
      if (gone < kBatch) {
        break;
      }
    }
    this.log.log(`notices cleaned: ${items} closed items with their rows, ${rows} read news rows`);
    return { items, rows };
  }
}
