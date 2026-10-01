import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";

import type { Env } from "../../../config/env.schema.js";
import { PrismaService } from "../../../database/prisma.service.js";
import { QUEUE_TOKEN, type Queues } from "../../../queue/queue.module.js";
import { JOB, QUEUE } from "../../../queue/queues.js";
import { localDateSql, localDay } from "../../timesheet/local-day.js";
import { INBOX_QUEUES, QUEUE_LEDGER, WAITING_STATE, type InboxQueue } from "../audience.service.js";
import { itemKey, NoticeItemsService } from "../notice-items.service.js";
import { DUE_SOON_DAYS, kebab, QUEUE_MARKS } from "../notice-kinds.js";
import { NotificationsService, type NoticeFacts } from "../notifications.service.js";

interface Waiting {
  subjectId: string;
  employeeId: number;
  daysWaited: number;
  payslipId: string | null;
  overdue: boolean;
}

// The reference the asker's notice carries, so it opens the record it is about.
const REFERENCE: Record<InboxQueue, keyof NoticeFacts> = {
  REQUESTS: "requestId",
  ADVANCES_TO_DECIDE: "advanceId",
  ADVANCES_TO_PAY: "advanceId",
  CERTIFICATES: "certificateId",
  PROFILE_CHANGES: "profileChangeId",
  DISPUTES: "disputeId",
  DEPENDENTS: "dependentId",
};

// A dispute speaks by its due date: once when it is a day away, once past it.
const DUE_SOON = 1;
const OVERDUE = 2;

// Eight in the morning read in APP_TIMEZONE rather than the server's UTC (KEHOACH 9.8).
const kDailyCron = "0 8 * * *";

@Injectable()
export class StalledSweep implements OnModuleInit {
  private readonly log = new Logger(StalledSweep.name);

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
   * Nudge both ends of work nobody has finished, in every inbox queue. The highest mark passed is
   * claimed on the item, so a mark is said once even after a missed day (KEHOACH 9.17 item 12).
   */
  async sweep(now: Date = new Date()): Promise<{ told: number }> {
    let told = 0;
    for (const queue of INBOX_QUEUES) {
      for (const row of await this.waiting(queue, now)) {
        const marks = QUEUE_MARKS[queue] ?? [];
        const mark = queue === "DISPUTES" ? (row.overdue ? OVERDUE : DUE_SOON) : Math.max(...marks.filter((one) => one <= row.daysWaited));
        if (await this.speak(queue, row, mark)) {
          told += 1;
        }
      }
    }
    this.log.log(`stalled work swept, ${told} told`);
    return { told };
  }

  private async waiting(queue: InboxQueue, now: Date): Promise<Waiting[]> {
    const ledger = QUEUE_LEDGER[queue];
    const today = localDay(now, this.zone);
    const since = localDateSql(Prisma.sql`s.${Prisma.raw(`"${ledger.since}"`)}`, this.zone);
    const due =
      queue === "DISPUTES"
        ? Prisma.sql`s."dueAt" <= ${new Date(now.getTime() + DUE_SOON_DAYS * 86_400_000)}`
        : Prisma.sql`(${today}::date - ${since}) >= ${(QUEUE_MARKS[queue] ?? [Number.MAX_SAFE_INTEGER])[0]}::int`;
    return this.db.$queryRaw<Waiting[]>`
      SELECT s."id" AS "subjectId", s."employeeId", (${today}::date - ${since})::int AS "daysWaited",
             ${queue === "DISPUTES" ? Prisma.sql`s."payslipId"` : Prisma.sql`NULL::text`} AS "payslipId",
             ${queue === "DISPUTES" ? Prisma.sql`s."dueAt" <= ${now}` : Prisma.sql`false`} AS "overdue"
        FROM ${Prisma.raw(`"${ledger.table}"`)} s
        JOIN "NoticeItem" i ON i."key" = ${`${kebab(queue)}:`} || s."id" AND i."state" = 'OPEN'
       WHERE s."state"::text = ${WAITING_STATE[queue]} AND ${due}
    `;
  }

  private async speak(queue: InboxQueue, row: Waiting, mark: number): Promise<boolean> {
    if (!(await this.items.claimMark(queue, row.subjectId, mark))) {
      return false;
    }
    if (queue === "DISPUTES" && row.overdue) {
      await this.db.noticeItem.updateMany({ where: { key: itemKey(queue, row.subjectId), state: "OPEN" }, data: { level: "WARNING" } });
    }
    await this.notices.raiseFor(row.employeeId, "REQUEST_STALLED", {
      [REFERENCE[queue]]: row.subjectId,
      ...(row.payslipId ? { payslipId: row.payslipId } : {}),
      daysWaited: row.daysWaited,
    });
    await this.items.remind(queue, row.subjectId, { daysWaited: row.daysWaited });
    return true;
  }
}
