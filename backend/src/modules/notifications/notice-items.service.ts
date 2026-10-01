import { Injectable, Logger } from "@nestjs/common";
import type { NoticeItem, NoticeItemState, NoticeOutcome, NoticeSubject } from "@prisma/client";

import { PrismaService } from "../../database/prisma.service.js";
import { FEED, RealtimeGateway } from "../realtime/realtime.gateway.js";
import { AudienceService, type InboxQueue } from "./audience.service.js";
import { kebab, type ItemKind } from "./notice-kinds.js";
import { NotificationsService, type NoticeFacts } from "./notifications.service.js";

export const QUEUE_SUBJECT: Record<InboxQueue, NoticeSubject> = {
  REQUESTS: "REQUEST",
  ADVANCES_TO_DECIDE: "ADVANCE",
  ADVANCES_TO_PAY: "ADVANCE",
  CERTIFICATES: "CERTIFICATE",
  PROFILE_CHANGES: "PROFILE_CHANGE",
  DISPUTES: "DISPUTE",
  DEPENDENTS: "DEPENDENT",
};

const ITEM_KIND: ItemKind = "REQUEST_WAITING";

export interface Closing {
  state: Exclude<NoticeItemState, "OPEN">;
  outcome?: NoticeOutcome | null;
  actorId?: string | null;
}

/** Whether newcomers to a group hear of the work, or find it in their inbox already read (KEHOACH 9.21.4). */
export type Joining = "announce" | "quiet";

export interface Regrouped {
  joined: number;
  left: number;
}

interface Seated {
  id: string;
  userId: string;
  requestId: string | null;
  advanceId: string | null;
  certificateId: string | null;
  profileChangeId: string | null;
  dependentId: string | null;
  payslipId: string | null;
  approved: boolean | null;
  daysWaited: number | null;
}

/** The key of the one item a subject has in a queue (KEHOACH 9.21.4). */
export function itemKey(queue: InboxQueue, subjectId: string): string {
  return `${kebab(queue)}:${subjectId}`;
}

function pushFacts(row: Seated): NoticeFacts {
  const facts: NoticeFacts = {};
  for (const key of ["requestId", "advanceId", "certificateId", "profileChangeId", "dependentId", "payslipId"] as const) {
    if (row[key] !== null) {
      facts[key] = row[key];
    }
  }
  if (row.approved !== null) {
    facts.approved = row.approved;
  }
  if (row.daysWaited !== null) {
    facts.daysWaited = row.daysWaited;
  }
  return facts;
}

/** The shared side of a piece of work: one item, a row per holder, closed once for all (KEHOACH 9.21.4). */
@Injectable()
export class NoticeItemsService {
  private readonly log = new Logger(NoticeItemsService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly audience: AudienceService,
    private readonly notices: NotificationsService,
    private readonly feed: RealtimeGateway,
  ) {}

  /** Open the item a waiting row casts and seat its group; a subject never has two in one queue.
   *  @ctx any | after the business commit; logs its own failures, which reconcile repairs
   */
  async open(queue: InboxQueue, subject: { id: string; employeeId: number }, joining: Joining = "announce"): Promise<void> {
    try {
      const key = itemKey(queue, subject.id);
      await this.db.noticeItem.createMany({
        data: [{ key, queue, subjectType: QUEUE_SUBJECT[queue], subjectId: subject.id, employeeId: subject.employeeId }],
        skipDuplicates: true,
      });
      const item = await this.db.noticeItem.findUniqueOrThrow({ where: { key } });
      if (item.state === "OPEN") {
        await this.regroup(item, joining);
      }
    } catch (fell) {
      this.log.error(`item ${queue} ${subject.id} did not open: ${String(fell)}`);
    }
  }

  /** Close the item for everybody: one UPDATE claims it, and only that call marks the rows read.
   *  @ctx any | after the business commit; logs its own failures, which reconcile repairs
   */
  async close(queue: InboxQueue, subjectId: string, closing: Closing): Promise<boolean> {
    try {
      const key = itemKey(queue, subjectId);
      const shut = await this.db.noticeItem.updateMany({
        where: { key, state: "OPEN" },
        data: {
          state: closing.state,
          outcome: closing.outcome ?? null,
          actorId: closing.actorId ?? null,
          closedAt: new Date(),
        },
      });
      if (shut.count !== 1) {
        return false;
      }
      const item = await this.db.noticeItem.findUniqueOrThrow({ where: { key }, select: { id: true } });
      await this.settle([item.id]);
      return true;
    } catch (fell) {
      this.log.error(`item ${queue} ${subjectId} did not close: ${String(fell)}`);
      return false;
    }
  }

  /** Every row of closed items reads as read from the close, and every holder's open screens hear it. */
  async settle(itemIds: string[]): Promise<void> {
    if (itemIds.length === 0) {
      return;
    }
    await this.db.$executeRaw`
      UPDATE "Notification" n
         SET "readAt" = i."closedAt"
        FROM "NoticeItem" i
       WHERE n."itemId" = i."id" AND i."id" = ANY(${itemIds}::text[]) AND n."readAt" IS NULL AND i."state" <> 'OPEN'
    `;
    const holders = await this.db.notification.findMany({
      where: { itemId: { in: itemIds }, leftAt: null },
      select: { userId: true, item: { select: { key: true, state: true, outcome: true, actorId: true, closedAt: true } } },
    });
    for (const one of holders) {
      if (one.item) {
        this.feed.tell(one.userId, FEED.notice, { op: "item", ...one.item, at: one.item.closedAt });
      }
    }
  }

  /** Seat whoever the work now waits on and mark whoever it left, by the inbox's own rule (KEHOACH 9.21.4).
   *  @ctx any | one audience count per candidate login
   */
  async regroup(item: NoticeItem, joining: Joining): Promise<Regrouped> {
    const { seated, left } = await this.reseat(item, joining);
    return { joined: seated.length, left: left.length };
  }

  /** Recount the groups of these people's open items now, telling newcomers as at filing (KEHOACH 9.21.4).
   *  @ctx any | after the commit that moved an approver; logs its own failures, which reconcile repairs
   */
  async regroupPeople(queue: InboxQueue, employeeIds: number[]): Promise<void> {
    if (employeeIds.length === 0) {
      return;
    }
    try {
      const items = await this.db.noticeItem.findMany({
        where: { queue, state: "OPEN", employeeId: { in: employeeIds } },
      });
      for (const item of items) {
        await this.regroup(item, "announce");
      }
    } catch (fell) {
      this.log.error(`${queue} items of ${employeeIds.length} people were not regrouped: ${String(fell)}`);
    }
  }

  /** Take a reminder mark; only the call that moves lastMark speaks, so a mark is said once (KEHOACH 9.21.4). */
  async claimMark(queue: InboxQueue, subjectId: string, mark: number): Promise<boolean> {
    const claimed = await this.db.noticeItem.updateMany({
      where: { key: itemKey(queue, subjectId), state: "OPEN", OR: [{ lastMark: null }, { lastMark: { lt: mark } }] },
      data: { lastMark: mark },
    });
    return claimed.count === 1;
  }

  /** Surface an open item for its whole group: unread, out of the archive, pushed again.
   *  @ctx any | after claimMark won; logs its own failures
   */
  async remind(queue: InboxQueue, subjectId: string, daysWaited: number): Promise<void> {
    try {
      const item = await this.db.noticeItem.findUnique({ where: { key: itemKey(queue, subjectId) } });
      if (!item || item.state !== "OPEN") {
        return;
      }
      const { seated } = await this.reseat(item, "announce");
      const fresh = seated.map((one) => one.userId);
      const surfaced = await this.db.$queryRaw<Seated[]>`
        UPDATE "Notification"
           SET "facts" = jsonb_build_object('daysWaited', ${daysWaited}::int), "daysWaited" = ${daysWaited}::int,
               "readAt" = NULL, "archivedAt" = NULL, "remindedAt" = now(),
               "remindCount" = "remindCount" + CASE WHEN "userId" = ANY(${fresh}::text[]) THEN 0 ELSE 1 END
         WHERE "itemId" = ${item.id} AND "leftAt" IS NULL
        RETURNING "id", "userId", "requestId", "advanceId", "certificateId", "profileChangeId", "dependentId",
                  "payslipId", "approved", "daysWaited"
      `;
      await this.notices.announce(
        ITEM_KIND,
        surfaced.filter((one) => !fresh.includes(one.userId)).map((one) => ({ ...one, facts: pushFacts(one) })),
      );
    } catch (fell) {
      this.log.error(`item ${queue} ${subjectId} was not reminded: ${String(fell)}`);
    }
  }

  private async reseat(item: NoticeItem, joining: Joining): Promise<{ seated: Seated[]; left: string[] }> {
    const audience = await this.audience.audienceOf(item.queue, item.subjectId);
    const left = await this.db.$queryRaw<{ userId: string }[]>`
      UPDATE "Notification" SET "leftAt" = now()
       WHERE "itemId" = ${item.id} AND "leftAt" IS NULL AND NOT ("userId" = ANY(${audience}::text[]))
      RETURNING "userId"
    `;
    const quiet = joining === "quiet";
    const seated =
      audience.length === 0
        ? []
        : await this.db.$queryRaw<Seated[]>`
            INSERT INTO "Notification" ("id", "userId", "kind", "itemId", "subjectType", "subjectId",
                                        "subjectEmployeeId", "dedupKey", "readAt", "requestId", "advanceId",
                                        "certificateId", "profileChangeId", "dependentId", "payslipId", "approved")
            SELECT gen_random_uuid()::text, seat."userId", ${ITEM_KIND}::"NoticeKind", i."id", i."subjectType",
                   i."subjectId", i."employeeId", i."key", CASE WHEN ${quiet}::boolean THEN now() END,
                   CASE WHEN i."subjectType" = 'REQUEST' THEN i."subjectId" END,
                   CASE WHEN i."subjectType" = 'ADVANCE' THEN i."subjectId" END,
                   CASE WHEN i."subjectType" = 'CERTIFICATE' THEN i."subjectId" END,
                   CASE WHEN i."subjectType" = 'PROFILE_CHANGE' THEN i."subjectId" END,
                   CASE WHEN i."subjectType" = 'DEPENDENT' THEN i."subjectId" END,
                   (SELECT d."payslipId" FROM "PayslipDispute" d WHERE i."subjectType" = 'DISPUTE' AND d."id" = i."subjectId"),
                   CASE WHEN i."queue" = 'ADVANCES_TO_PAY' THEN true END
              FROM "NoticeItem" i
             CROSS JOIN unnest(${audience}::text[]) AS seat("userId")
             WHERE i."id" = ${item.id} AND i."state" = 'OPEN'
            ON CONFLICT ("userId", "dedupKey") DO UPDATE
               SET "leftAt" = NULL,
                   "readAt" = CASE WHEN ${quiet}::boolean THEN COALESCE("Notification"."readAt", now()) END
             WHERE "Notification"."leftAt" IS NOT NULL
            RETURNING "id", "userId", "requestId", "advanceId", "certificateId", "profileChangeId", "dependentId",
                      "payslipId", "approved", "daysWaited"
          `;
    for (const one of left) {
      this.feed.tell(one.userId, FEED.notice, { op: "item", key: item.key, state: item.state });
    }
    if (quiet) {
      for (const one of seated) {
        this.feed.tell(one.userId, FEED.notice, { op: "item", key: item.key, state: item.state });
      }
    } else {
      await this.notices.announce(ITEM_KIND, seated.map((one) => ({ ...one, facts: pushFacts(one) })));
    }
    return { seated, left: left.map((one) => one.userId) };
  }
}
