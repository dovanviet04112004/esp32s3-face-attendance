import { ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type {
  NoticeItem,
  NoticeItemState,
  NoticeLevel,
  NoticeOutcome,
  NoticeQueue,
  NoticeSubject,
  Prisma,
} from "@prisma/client";

import type { Viewer } from "../../common/scope/viewer.js";
import type { Env } from "../../config/env.schema.js";
import { PrismaService } from "../../database/prisma.service.js";
import { FEED, RealtimeGateway } from "../realtime/realtime.gateway.js";
import { AudienceService, type InboxQueue } from "./audience.service.js";
import { kebab, type ItemKind } from "./notice-kinds.js";
import { NAMED, nameOf, NotificationsService } from "./notifications.service.js";
import { SubjectsService, type SubjectView } from "./subjects.service.js";

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
  dedupKey: string;
  at: Date;
}

// Work that takes more than one click to finish, where the group needs to see who is on it (KEHOACH 9.21.4).
export const CLAIMABLE: ReadonlySet<NoticeQueue> = new Set<NoticeQueue>(["DISPUTES", "CERTIFICATES"]);

/** An item as its group reads it: its state and result, who is on it, whom it reached and who has read it. */
export interface ItemDetail {
  key: string;
  queue: NoticeQueue;
  level: NoticeLevel;
  state: NoticeItemState;
  outcome: NoticeOutcome | null;
  actorName: string | null;
  openedAt: Date;
  closedAt: Date | null;
  dueAt: Date | null;
  claimable: boolean;
  claimedByName: string | null;
  claimedAt: Date | null;
  subject: SubjectView | null;
  holders: { name: string | null; readAt: Date | null; leftAt: Date | null }[] | null;
}

const ITEM_READ = {
  actor: NAMED,
  claimedBy: NAMED,
  rows: { select: { userId: true, readAt: true, leftAt: true, user: NAMED }, orderBy: { createdAt: "asc" } },
} satisfies Prisma.NoticeItemInclude;

type ItemRead = Prisma.NoticeItemGetPayload<{ include: typeof ITEM_READ }>;

const kHourMs = 3_600_000;

/** The key of the one item a subject has in a queue (KEHOACH 9.21.4). */
export function itemKey(queue: InboxQueue, subjectId: string): string {
  return `${kebab(queue)}:${subjectId}`;
}

/** The shared side of a piece of work: one item, a row per holder, closed once for all (KEHOACH 9.21.4). */
@Injectable()
export class NoticeItemsService {
  private readonly log = new Logger(NoticeItemsService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly audience: AudienceService,
    private readonly notices: NotificationsService,
    private readonly subjects: SubjectsService,
    private readonly feed: RealtimeGateway,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** An item for a reader who holds a row of it, the person it is about, or an ADMIN; only the group and ADMIN see whom it reached.
   *  @ctx any | NOTICE_NOT_FOUND for anybody else
   */
  async detail(viewer: Viewer, key: string): Promise<ItemDetail> {
    const { item, member } = await this.reachable(viewer, key);
    const [subject] = await this.subjects.describe(viewer, [
      { subjectType: item.subjectType, subjectId: item.subjectId, subjectEmployeeId: item.employeeId },
    ]);
    const lapsed = Date.now() - this.config.get("NOTICE_CLAIM_HOURS", { infer: true }) * kHourMs;
    const claimLive = item.claimedAt !== null && item.claimedAt.getTime() > lapsed;
    return {
      key: item.key,
      queue: item.queue,
      level: item.level,
      state: item.state,
      outcome: item.outcome,
      actorName: nameOf(item.actor),
      openedAt: item.openedAt,
      closedAt: item.closedAt,
      dueAt: item.dueAt,
      claimable: CLAIMABLE.has(item.queue),
      claimedByName: claimLive ? nameOf(item.claimedBy) : null,
      claimedAt: claimLive ? item.claimedAt : null,
      subject,
      holders:
        member || viewer.role === "ADMIN"
          ? item.rows.map((row) => ({ name: nameOf(row.user), readAt: row.readAt, leftAt: row.leftAt }))
          : null,
    };
  }

  /** Say "I am on it" for the whole group to see; it lapses after NOTICE_CLAIM_HOURS.
   *  @ctx any | group members only, on queues that take a claim
   */
  async claim(viewer: Viewer, key: string): Promise<ItemDetail> {
    const { item, member } = await this.reachable(viewer, key);
    if (!member || !CLAIMABLE.has(item.queue)) {
      throw new NotFoundException("NOTICE_NOT_FOUND");
    }
    const held = await this.db.noticeItem.updateMany({
      where: { id: item.id, state: "OPEN" },
      data: { claimedById: viewer.userId, claimedAt: new Date() },
    });
    if (held.count !== 1) {
      throw new ConflictException("NOTICE_ITEM_CLOSED");
    }
    this.tellHolders(item);
    return this.detail(viewer, key);
  }

  /** Let go of one's own claim; somebody else's stays. */
  async unclaim(viewer: Viewer, key: string): Promise<ItemDetail> {
    const { item, member } = await this.reachable(viewer, key);
    if (!member || !CLAIMABLE.has(item.queue)) {
      throw new NotFoundException("NOTICE_NOT_FOUND");
    }
    const freed = await this.db.noticeItem.updateMany({
      where: { id: item.id, claimedById: viewer.userId },
      data: { claimedById: null, claimedAt: null },
    });
    if (freed.count > 0) {
      this.tellHolders(item);
    }
    return this.detail(viewer, key);
  }

  /** Close an item by hand, kept for kinds no business path decides; every inbox queue has one (KEHOACH 9.21.4).
   *  @ctx any | NOTICE_NOT_FOUND outside the group, NOTICE_ITEM_NOT_RESOLVABLE for an inbox queue
   */
  async resolve(viewer: Viewer, key: string): Promise<ItemDetail> {
    const { member } = await this.reachable(viewer, key);
    if (!member) {
      throw new NotFoundException("NOTICE_NOT_FOUND");
    }
    throw new ConflictException("NOTICE_ITEM_NOT_RESOLVABLE");
  }

  private async reachable(viewer: Viewer, key: string): Promise<{ item: ItemRead; member: boolean }> {
    const item = await this.db.noticeItem.findUnique({ where: { key }, include: ITEM_READ });
    const mine = item?.rows.find((row) => row.userId === viewer.userId);
    const about = item !== null && viewer.employeeId !== null && item.employeeId === viewer.employeeId;
    if (!item || (!mine && !about && viewer.role !== "ADMIN")) {
      throw new NotFoundException("NOTICE_NOT_FOUND");
    }
    return { item, member: mine !== undefined && mine.leftAt === null };
  }

  private tellHolders(item: ItemRead): void {
    for (const row of item.rows) {
      if (row.leftAt === null) {
        this.feed.tell(row.userId, FEED.notice, { op: "item", key: item.key, state: item.state });
      }
    }
  }

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
        RETURNING "id", "userId", "dedupKey", "remindedAt" AS "at"
      `;
      await this.notices.announce(
        ITEM_KIND,
        surfaced.filter((one) => !fresh.includes(one.userId)).map((one) => ({ ...one, renotify: true })),
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
              JOIN "User" u ON u."id" = seat."userId"
             WHERE i."id" = ${item.id} AND i."state" = 'OPEN'
            ON CONFLICT ("userId", "dedupKey") DO UPDATE
               SET "leftAt" = NULL,
                   "readAt" = CASE WHEN ${quiet}::boolean THEN COALESCE("Notification"."readAt", now()) END
             WHERE "Notification"."leftAt" IS NOT NULL
            RETURNING "id", "userId", "dedupKey", now()::timestamp(3) AS "at"
          `;
    for (const one of left) {
      this.feed.tell(one.userId, FEED.notice, { op: "item", key: item.key, state: item.state });
    }
    if (quiet) {
      for (const one of seated) {
        this.feed.tell(one.userId, FEED.notice, { op: "item", key: item.key, state: item.state });
      }
    } else {
      await this.notices.announce(ITEM_KIND, seated.map((one) => ({ ...one, renotify: false })));
    }
    return { seated, left: left.map((one) => one.userId) };
  }
}
