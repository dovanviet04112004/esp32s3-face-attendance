import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import type { Env } from "../../../config/env.schema.js";
import { PrismaService } from "../../../database/prisma.service.js";
import { QUEUE_TOKEN, type Queues } from "../../../queue/queue.module.js";
import { JOB, QUEUE } from "../../../queue/queues.js";
import { CLOSED_STAMP } from "../notice-items.service.js";

// Twenty to three in the morning in APP_TIMEZONE, clear of the 00:30 day build (KEHOACH 9.8).
const kNightlyCron = "40 2 * * *";
const kBatch = 5000;
const kDayMs = 86_400_000;

async function inBatches(deleteBatch: () => Promise<number>): Promise<number> {
  let gone = 0;
  for (;;) {
    const deleted = await deleteBatch();
    gone += deleted;
    if (deleted < kBatch) {
      return gone;
    }
  }
}

/** Drops what the bell has stopped needing: news long read, the rows of work long closed, and work a reopening moved aside (KEHOACH 9.21.4). */
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

  /** Delete in batches news read, and rows of work closed, NOTICE_KEEP_DAYS ago. Closed work keeps its item as the mark
   *  no sweep opens again; only work a reopening moved aside goes whole, and open work is never touched.
   *  @ctx job | one bounded DELETE at a time, so the bell's table is never locked for long
   */
  async sweep(now: Date = new Date()): Promise<{ items: number; rows: number }> {
    const cutoff = new Date(now.getTime() - this.config.get("NOTICE_KEEP_DAYS", { infer: true }) * kDayMs);
    const work = await inBatches(
      () => this.db.$executeRaw`
        DELETE FROM "Notification" WHERE "id" IN (
          SELECT n."id" FROM "Notification" n JOIN "NoticeItem" i ON i."id" = n."itemId"
           WHERE i."state" <> 'OPEN' AND i."closedAt" < ${cutoff} LIMIT ${kBatch}
        )
      `,
    );
    const items = await inBatches(
      () => this.db.$executeRaw`
        DELETE FROM "NoticeItem" WHERE "id" IN (
          SELECT "id" FROM "NoticeItem"
           WHERE "state" <> 'OPEN' AND "closedAt" < ${cutoff} AND "key" LIKE '%:' || ${CLOSED_STAMP} LIMIT ${kBatch}
        )
      `,
    );
    const news = await inBatches(
      () => this.db.$executeRaw`
        DELETE FROM "Notification" WHERE "id" IN (
          SELECT "id" FROM "Notification" WHERE "itemId" IS NULL AND "readAt" < ${cutoff} LIMIT ${kBatch}
        )
      `,
    );
    this.log.log(`notices cleaned: ${work} rows of closed work, ${items} items moved aside, ${news} read news rows`);
    return { items, rows: work + news };
  }
}
