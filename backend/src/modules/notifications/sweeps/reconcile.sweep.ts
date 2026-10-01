import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";

import type { Env } from "../../../config/env.schema.js";
import { PrismaService } from "../../../database/prisma.service.js";
import { QUEUE_TOKEN, type Queues } from "../../../queue/queue.module.js";
import { JOB, QUEUE } from "../../../queue/queues.js";
import { INBOX_QUEUES, WAITING_STATE, type InboxQueue } from "../audience.service.js";
import { NoticeItemsService } from "../notice-items.service.js";
import { kebab } from "../notice-kinds.js";

/** How a queue's finished business row reads as a closed item; `s` is that row, as the backfill read it. */
interface Ledger {
  table: string;
  state: string;
  outcome: string;
  actor: string;
  closedAt: string;
}

const ASKER = `(SELECT u."id" FROM "User" u WHERE u."employeeId" = s."employeeId")`;

const LEDGERS: Record<InboxQueue, Ledger> = {
  REQUESTS: {
    table: "Request",
    state: `CASE s."state" WHEN 'CANCELLED' THEN 'WITHDRAWN' ELSE 'DONE' END`,
    outcome: `CASE s."state" WHEN 'APPROVED' THEN 'APPROVED' WHEN 'REJECTED' THEN 'REJECTED' END`,
    actor: `CASE s."state" WHEN 'CANCELLED' THEN ${ASKER} ELSE s."decidedById" END`,
    closedAt: `COALESCE(s."decidedAt", s."updatedAt")`,
  },
  ADVANCES_TO_DECIDE: {
    table: "SalaryAdvance",
    state: `CASE s."state" WHEN 'CANCELLED' THEN 'WITHDRAWN' ELSE 'DONE' END`,
    outcome: `CASE WHEN s."state" = 'REJECTED' THEN 'REJECTED' WHEN s."state" IN ('APPROVED', 'PAID', 'SETTLED') THEN 'APPROVED' END`,
    actor: `CASE s."state" WHEN 'CANCELLED' THEN ${ASKER} ELSE s."decidedById" END`,
    closedAt: `COALESCE(s."decidedAt", now()::timestamp(3))`,
  },
  // The advance does not record who paid it; the audit trail does (KEHOACH 9.24).
  ADVANCES_TO_PAY: {
    table: "SalaryAdvance",
    state: `CASE WHEN s."state" IN ('PAID', 'SETTLED') THEN 'DONE' ELSE 'EXPIRED' END`,
    outcome: `CASE WHEN s."state" IN ('PAID', 'SETTLED') THEN 'PAID' END`,
    actor: `(SELECT l."actorId" FROM "AuditLog" l WHERE l."subjectType" = 'advance' AND l."subjectId" = s."id"
               AND l."action" = 'advance.pay' ORDER BY l."ts" DESC LIMIT 1)`,
    closedAt: `COALESCE(s."paidAt", now()::timestamp(3))`,
  },
  CERTIFICATES: {
    table: "Certificate",
    state: `CASE s."state" WHEN 'CANCELLED' THEN 'WITHDRAWN' ELSE 'DONE' END`,
    outcome: `CASE s."state" WHEN 'ISSUED' THEN 'ISSUED' WHEN 'REJECTED' THEN 'REJECTED' END`,
    actor: `CASE s."state" WHEN 'CANCELLED' THEN ${ASKER} ELSE s."issuedById" END`,
    closedAt: `COALESCE(s."issuedAt", s."updatedAt")`,
  },
  PROFILE_CHANGES: {
    table: "ProfileChange",
    state: `CASE s."state" WHEN 'CANCELLED' THEN 'WITHDRAWN' ELSE 'DONE' END`,
    outcome: `CASE s."state" WHEN 'APPROVED' THEN 'APPROVED' WHEN 'REJECTED' THEN 'REJECTED' END`,
    actor: `CASE s."state" WHEN 'CANCELLED' THEN COALESCE(s."askedById", ${ASKER}) ELSE s."decidedById" END`,
    closedAt: `COALESCE(s."decidedAt", s."updatedAt")`,
  },
  DISPUTES: {
    table: "PayslipDispute",
    state: `CASE s."state" WHEN 'WITHDRAWN' THEN 'WITHDRAWN' ELSE 'DONE' END`,
    outcome: `CASE WHEN s."state" = 'ANSWERED' THEN s."outcome"::text END`,
    actor: `CASE s."state" WHEN 'WITHDRAWN' THEN ${ASKER} ELSE s."answeredById" END`,
    closedAt: `COALESCE(s."answeredAt", s."updatedAt")`,
  },
  DEPENDENTS: {
    table: "Dependent",
    state: `'DONE'`,
    outcome: `CASE WHEN s."state" = 'REJECTED' THEN 'REJECTED' WHEN s."state" IN ('ACTIVE', 'ENDED') THEN 'APPROVED' END`,
    actor: `s."decidedById"`,
    closedAt: `COALESCE(s."decidedAt", s."updatedAt")`,
  },
};

const kPage = 500;

/** Per queue: items a write path forgot to close or open, which must be 0, and the group changes, which need not. */
export interface Reconciled {
  closed: number;
  opened: number;
  joined: number;
  left: number;
}

@Injectable()
export class ReconcileSweep implements OnModuleInit {
  private readonly log = new Logger(ReconcileSweep.name);

  constructor(
    private readonly db: PrismaService,
    private readonly items: NoticeItemsService,
    private readonly config: ConfigService<Env, true>,
    @Inject(QUEUE_TOKEN) private readonly queues: Queues,
  ) {}

  // Upserting by scheduler id: a restart re-states it, never adds a second.
  async onModuleInit(): Promise<void> {
    const pattern = this.config.get("NOTICE_RECONCILE_CRON", { infer: true });
    const tz = this.config.get("APP_TIMEZONE", { infer: true });
    const queue = this.queues[QUEUE.notify];
    if (!pattern) {
      await queue.removeJobScheduler("notice-reconcile");
      return;
    }
    await queue.upsertJobScheduler(
      "notice-reconcile",
      { pattern, tz },
      { name: JOB.noticeReconcile, data: { type: JOB.noticeReconcile } },
    );
  }

  /** Bring every item in line with its business row, then recount every open group (KEHOACH 9.21.4).
   *  @ctx job | one statement per queue, then one regroup per open item
   */
  async sweep(): Promise<Record<InboxQueue, Reconciled>> {
    const tally = Object.fromEntries(
      INBOX_QUEUES.map((queue) => [queue, { closed: 0, opened: 0, joined: 0, left: 0 }]),
    ) as Record<InboxQueue, Reconciled>;
    for (const queue of INBOX_QUEUES) {
      const closed = await this.closeFinished(queue);
      await this.items.settle(closed);
      tally[queue].closed = closed.length;
      tally[queue].opened = await this.openMissing(queue);
    }
    let after: string | undefined;
    for (;;) {
      const page = await this.db.noticeItem.findMany({
        where: { state: "OPEN", queue: { in: [...INBOX_QUEUES] }, ...(after ? { id: { gt: after } } : {}) },
        orderBy: { id: "asc" },
        take: kPage,
      });
      for (const item of page) {
        const moved = await this.items.regroup(item, "quiet");
        tally[item.queue].joined += moved.joined;
        tally[item.queue].left += moved.left;
      }
      if (page.length < kPage) {
        break;
      }
      after = page[page.length - 1].id;
    }
    for (const queue of INBOX_QUEUES) {
      const one = tally[queue];
      if (one.closed + one.opened > 0) {
        this.log.warn(`${queue}: ${one.closed} closed and ${one.opened} opened that a write path left behind`);
      }
    }
    const sum = (field: keyof Reconciled) => INBOX_QUEUES.reduce((total, queue) => total + tally[queue][field], 0);
    this.log.log(
      `notice items reconciled: ${sum("closed")} closed, ${sum("opened")} opened, ${sum("joined")} joined, ${sum("left")} left`,
    );
    return tally;
  }

  private async closeFinished(queue: InboxQueue): Promise<string[]> {
    const ledger = LEDGERS[queue];
    const rows = await this.db.$queryRaw<{ id: string }[]>`
      UPDATE "NoticeItem" i
         SET "state" = x."state"::"NoticeItemState", "outcome" = x."outcome"::"NoticeOutcome",
             "actorId" = x."actorId", "closedAt" = x."closedAt"
        FROM (
          SELECT n."id",
                 CASE WHEN s."id" IS NULL THEN 'EXPIRED' ELSE ${Prisma.raw(ledger.state)} END AS "state",
                 CASE WHEN s."id" IS NULL THEN NULL ELSE ${Prisma.raw(ledger.outcome)} END AS "outcome",
                 CASE WHEN s."id" IS NULL THEN NULL ELSE ${Prisma.raw(ledger.actor)} END AS "actorId",
                 CASE WHEN s."id" IS NULL THEN now()::timestamp(3) ELSE ${Prisma.raw(ledger.closedAt)} END AS "closedAt"
            FROM "NoticeItem" n
            LEFT JOIN ${Prisma.raw(`"${ledger.table}"`)} s ON s."id" = n."subjectId"
           WHERE n."queue" = ${queue}::"NoticeQueue" AND n."state" = 'OPEN'
             AND (s."id" IS NULL OR s."state"::text <> ${WAITING_STATE[queue]})
        ) x
       WHERE i."id" = x."id" AND i."state" = 'OPEN'
      RETURNING i."id"
    `;
    return rows.map((row) => row.id);
  }

  private async openMissing(queue: InboxQueue): Promise<number> {
    const waiting = await this.db.$queryRaw<{ id: string; employeeId: number }[]>`
      SELECT s."id", s."employeeId"
        FROM ${Prisma.raw(`"${LEDGERS[queue].table}"`)} s
       WHERE s."state"::text = ${WAITING_STATE[queue]}
         AND NOT EXISTS (SELECT 1 FROM "NoticeItem" i WHERE i."key" = ${`${kebab(queue)}:`} || s."id")
    `;
    for (const subject of waiting) {
      await this.items.open(queue, subject, "quiet");
    }
    return waiting.length;
  }
}
