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
  Role,
} from "@prisma/client";

import type { Viewer } from "../../common/scope/viewer.js";
import type { Env } from "../../config/env.schema.js";
import { PrismaService } from "../../database/prisma.service.js";
import { FEED, RealtimeGateway } from "../realtime/realtime.gateway.js";
import { AUDIT_ACTIONS, AUDIT_SUBJECTS } from "../audit/audit-actions.js";
import { AuditService } from "../audit/audit.service.js";
import { AudienceService } from "./audience.service.js";
import { DUE_MARKS, DUE_WARNING, kebab, type ItemKind } from "./notice-kinds.js";
import { NAMED, nameOf, NotificationsService } from "./notifications.service.js";
import { SubjectsService, type SubjectView } from "./subjects.service.js";

export const QUEUE_SUBJECT: Record<NoticeQueue, NoticeSubject> = {
  REQUESTS: "REQUEST",
  ADVANCES_TO_DECIDE: "ADVANCE",
  ADVANCES_TO_PAY: "ADVANCE",
  CERTIFICATES: "CERTIFICATE",
  PROFILE_CHANGES: "PROFILE_CHANGE",
  DISPUTES: "DISPUTE",
  DEPENDENTS: "DEPENDENT",
  CONTRACTS_DUE: "CONTRACT",
  PROBATION_DUE: "CONTRACT",
  BACKUP: "BACKUP",
  KIOSK: "DEVICE",
};

/** The kind a queue's work is told as. */
export const QUEUE_KIND: Record<NoticeQueue, ItemKind> = {
  REQUESTS: "REQUEST_WAITING",
  ADVANCES_TO_DECIDE: "REQUEST_WAITING",
  ADVANCES_TO_PAY: "REQUEST_WAITING",
  CERTIFICATES: "REQUEST_WAITING",
  PROFILE_CHANGES: "REQUEST_WAITING",
  DISPUTES: "REQUEST_WAITING",
  DEPENDENTS: "REQUEST_WAITING",
  CONTRACTS_DUE: "CONTRACT_DUE",
  PROBATION_DUE: "PROBATION_DUE",
  BACKUP: "BACKUP_ALERT",
  KIOSK: "KIOSK_ALERT",
};

// Only work no business path decides closes by hand: by the desk that signs, or for a kiosk an ADMIN (KEHOACH 9.21.4).
const RESOLVERS: Partial<Record<NoticeQueue, readonly Role[]>> = {
  CONTRACTS_DUE: ["ADMIN", "HR"],
  PROBATION_DUE: ["ADMIN", "HR"],
  KIOSK: ["ADMIN"],
};

export interface Closing {
  state: Exclude<NoticeItemState, "OPEN">;
  outcome?: NoticeOutcome | null;
  actorId?: string | null;
}

/** Whether newcomers to a group hear of the work, or find it in their inbox already read (KEHOACH 9.21.4). */
export type Joining = "announce" | "quiet";

/** What work is about; the part tells apart one subject's independent pieces of work in a queue (KEHOACH 9.21.4). */
export interface WorkRef {
  id: string;
  part?: string;
}

/** The subject work opens on, and the person it is about, when it is about one. */
export interface Opened extends WorkRef {
  employeeId: number | null;
}

/** What work carries from its first moment, and whether its group hears it open. */
export interface Opening {
  joining?: Joining;
  level?: NoticeLevel;
  facts?: Prisma.InputJsonObject;
  dueAt?: Date;
}

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

// A condition that comes and goes on one subject, so its closed work makes way for the next (KEHOACH 9.21.4).
const RECURRING: ReadonlySet<NoticeQueue> = new Set<NoticeQueue>(["BACKUP", "KIOSK"]);

// Work that takes more than one click to finish, where the group needs to see who is on it (KEHOACH 9.21.4).
export const CLAIMABLE: ReadonlySet<NoticeQueue> = new Set<NoticeQueue>(["DISPUTES", "CERTIFICATES", "CONTRACTS_DUE", "PROBATION_DUE"]);

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
  resolvable: boolean;
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

/** The key of the one open item a subject, or one part of it, has in a queue (KEHOACH 9.21.4). */
export function itemKey(queue: NoticeQueue, subject: string | WorkRef): string {
  const ref = typeof subject === "string" ? { id: subject } : subject;
  return ref.part ? `${kebab(queue)}:${ref.id}:${ref.part}` : `${kebab(queue)}:${ref.id}`;
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
    private readonly audit: AuditService,
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
      resolvable: RESOLVERS[item.queue]?.includes(viewer.role) ?? false,
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

  /** Close work by hand with a note, for kinds no business decision closes; audited (KEHOACH 9.21.4, 9.24).
   *  @ctx any | NOTICE_NOT_FOUND outside the group, NOTICE_ITEM_NOT_RESOLVABLE for work its own queue decides
   */
  async resolve(viewer: Viewer, key: string, note: string): Promise<ItemDetail> {
    const { item, member } = await this.reachable(viewer, key);
    if (!member) {
      throw new NotFoundException("NOTICE_NOT_FOUND");
    }
    if (!(RESOLVERS[item.queue]?.includes(viewer.role) ?? false)) {
      throw new ConflictException("NOTICE_ITEM_NOT_RESOLVABLE");
    }
    if (!(await this.shut(item.key, { state: "DONE", outcome: "RESOLVED", actorId: viewer.userId }))) {
      throw new ConflictException("NOTICE_ITEM_CLOSED");
    }
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.NOTICE_RESOLVE,
      subject: AUDIT_SUBJECTS.EMPLOYEE,
      subjectId: String(item.employeeId ?? ""),
      meta: { key: item.key, note },
    });
    return this.detail(viewer, key);
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

  /** Open the item a waiting row casts and seat its group, answering whether this call opened it.
   *  @ctx any | after the business commit; logs its own failures, which reconcile repairs
   */
  async open(queue: NoticeQueue, subject: Opened, opening: Opening = {}): Promise<boolean> {
    const key = itemKey(queue, subject);
    try {
      if (RECURRING.has(queue)) {
        await this.retire(key);
      }
      const made = await this.db.noticeItem.createMany({
        data: [
          {
            key,
            queue,
            subjectType: QUEUE_SUBJECT[queue],
            subjectId: subject.id,
            employeeId: subject.employeeId,
            level: opening.level,
            facts: opening.facts,
            dueAt: opening.dueAt,
          },
        ],
        skipDuplicates: true,
      });
      const item = await this.db.noticeItem.findUniqueOrThrow({ where: { key } });
      if (item.state === "OPEN") {
        await this.regroup(item, opening.joining ?? "announce");
      }
      return made.count === 1;
    } catch (fell) {
      this.log.error(`item ${key} did not open: ${String(fell)}`);
      return false;
    }
  }

  // A closed item steps aside with its rows, keeping who handled it, so the condition can open again.
  private async retire(key: string): Promise<void> {
    await this.db.$executeRaw`
      WITH old AS (
        UPDATE "NoticeItem" SET "key" = "key" || ':' || (extract(epoch FROM "closedAt") * 1000)::bigint
         WHERE "key" = ${key} AND "state" <> 'OPEN'
        RETURNING "id", "key"
      )
      UPDATE "Notification" n SET "dedupKey" = old."key" FROM old WHERE n."itemId" = old."id"
    `;
  }

  /** Close the item for everybody: one UPDATE claims it, and only that call marks the rows read.
   *  @ctx any | after the business commit; logs its own failures, which reconcile repairs
   */
  async close(queue: NoticeQueue, subject: string | WorkRef, closing: Closing): Promise<boolean> {
    return this.shut(itemKey(queue, subject), closing);
  }

  private async shut(key: string, closing: Closing): Promise<boolean> {
    try {
      const moved = await this.db.noticeItem.updateMany({
        where: { key, state: "OPEN" },
        data: {
          state: closing.state,
          outcome: closing.outcome ?? null,
          actorId: closing.actorId ?? null,
          closedAt: new Date(),
        },
      });
      if (moved.count !== 1) {
        return false;
      }
      const item = await this.db.noticeItem.findUniqueOrThrow({ where: { key }, select: { id: true } });
      await this.settle([item.id]);
      return true;
    } catch (fell) {
      this.log.error(`item ${key} did not close: ${String(fell)}`);
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
  async regroupPeople(queue: NoticeQueue, employeeIds: number[]): Promise<void> {
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
  async claimMark(queue: NoticeQueue, subject: string | WorkRef, mark: number): Promise<boolean> {
    const claimed = await this.db.noticeItem.updateMany({
      where: { key: itemKey(queue, subject), state: "OPEN", OR: [{ lastMark: null }, { lastMark: { lt: mark } }] },
      data: { lastMark: mark },
    });
    return claimed.count === 1;
  }

  /** Open work against a date and speak at the days-left mark it has passed; the first mark is the opening.
   *  @ctx any | the mark is claimed on the item, so each is said once, a missed day included (KEHOACH 9.18)
   */
  async speakDue(queue: "CONTRACTS_DUE" | "PROBATION_DUE", subject: { id: string; employeeId: number }, daysLeft: number): Promise<boolean> {
    const passed = (DUE_MARKS[queue] ?? []).filter((one) => daysLeft <= one).length;
    if (passed === 0) {
      return false;
    }
    const key = itemKey(queue, subject.id);
    const fresh = !(await this.db.noticeItem.findUnique({ where: { key }, select: { id: true } }));
    if (fresh) {
      await this.open(queue, subject);
    }
    if (!(await this.claimMark(queue, subject.id, passed))) {
      return false;
    }
    const warning = DUE_WARNING[queue];
    if (warning !== undefined && daysLeft <= warning) {
      await this.db.noticeItem.updateMany({ where: { key, state: "OPEN" }, data: { level: "WARNING" } });
    }
    // Work this sweep opened has just been told; a reminder on top would say one thing twice.
    if (fresh) {
      await this.db.notification.updateMany({ where: { item: { key } }, data: { facts: { daysLeft }, daysLeft } });
    } else {
      await this.remind(queue, subject.id, { daysLeft });
    }
    return true;
  }

  /** Surface an open item for its whole group: unread, out of the archive, pushed again.
   *  @ctx any | after claimMark won; logs its own failures
   */
  async remind(queue: NoticeQueue, subject: string | WorkRef, count: { daysWaited: number } | { daysLeft: number }): Promise<void> {
    const key = itemKey(queue, subject);
    try {
      const item = await this.db.noticeItem.findUnique({ where: { key } });
      if (!item || item.state !== "OPEN") {
        return;
      }
      const { seated } = await this.reseat(item, "announce");
      const fresh = seated.map((one) => one.userId);
      const surfaced = await this.db.$queryRaw<Seated[]>`
        UPDATE "Notification"
           SET "facts" = ${JSON.stringify(count)}::jsonb,
               "daysWaited" = ${"daysWaited" in count ? count.daysWaited : null}::int,
               "daysLeft" = ${"daysLeft" in count ? count.daysLeft : null}::int,
               "readAt" = NULL, "archivedAt" = NULL, "remindedAt" = now(),
               "remindCount" = "remindCount" + CASE WHEN "userId" = ANY(${fresh}::text[]) THEN 0 ELSE 1 END
         WHERE "itemId" = ${item.id} AND "leftAt" IS NULL
        RETURNING "id", "userId", "dedupKey", "remindedAt" AS "at"
      `;
      await this.notices.announce(
        QUEUE_KIND[queue],
        surfaced.filter((one) => !fresh.includes(one.userId)).map((one) => ({ ...one, renotify: true })),
      );
    } catch (fell) {
      this.log.error(`item ${key} was not reminded: ${String(fell)}`);
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
                                        "subjectEmployeeId", "dedupKey", "facts", "readAt", "requestId", "advanceId",
                                        "certificateId", "profileChangeId", "dependentId", "payslipId", "approved",
                                        "contractId")
            SELECT gen_random_uuid()::text, seat."userId", ${QUEUE_KIND[item.queue]}::"NoticeKind", i."id", i."subjectType",
                   i."subjectId", i."employeeId", i."key", i."facts", CASE WHEN ${quiet}::boolean THEN now() END,
                   CASE WHEN i."subjectType" = 'REQUEST' THEN i."subjectId" END,
                   CASE WHEN i."subjectType" = 'ADVANCE' THEN i."subjectId" END,
                   CASE WHEN i."subjectType" = 'CERTIFICATE' THEN i."subjectId" END,
                   CASE WHEN i."subjectType" = 'PROFILE_CHANGE' THEN i."subjectId" END,
                   CASE WHEN i."subjectType" = 'DEPENDENT' THEN i."subjectId" END,
                   (SELECT d."payslipId" FROM "PayslipDispute" d WHERE i."subjectType" = 'DISPUTE' AND d."id" = i."subjectId"),
                   CASE WHEN i."queue" = 'ADVANCES_TO_PAY' THEN true END,
                   CASE WHEN i."subjectType" = 'CONTRACT' THEN i."subjectId" END
              FROM "NoticeItem" i
             CROSS JOIN unnest(${audience}::text[]) AS seat("userId")
              JOIN "User" u ON u."id" = seat."userId"
             WHERE i."id" = ${item.id} AND i."state" = 'OPEN'
               FOR KEY SHARE OF u
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
      await this.notices.announce(QUEUE_KIND[item.queue], seated.map((one) => ({ ...one, renotify: false })));
    }
    return { seated, left: left.map((one) => one.userId) };
  }
}
