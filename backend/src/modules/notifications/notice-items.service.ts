import { ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  Prisma,
  type NoticeItem,
  type NoticeItemState,
  type NoticeLevel,
  type NoticeOutcome,
  type NoticeQueue,
  type NoticeSubject,
} from "@prisma/client";

import type { Viewer } from "../../common/scope/viewer.js";
import type { Env } from "../../config/env.schema.js";
import { PrismaService } from "../../database/prisma.service.js";
import { FEED, RealtimeGateway } from "../realtime/realtime.gateway.js";
import { AUDIT_ACTIONS, AUDIT_SUBJECTS } from "../audit/audit-actions.js";
import { AuditService, type AuditEntry } from "../audit/audit.service.js";
import { AudienceService } from "./audience.service.js";
import { CLAIMABLE, DUE_MARKS, DUE_WARNING, kebab, mayResolve, NOTICE_KINDS, type ItemKind } from "./notice-kinds.js";
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
  TASKS: "TASK",
  DOCUMENTS: "DOCUMENT",
  ATTENDANCE: "PERSON_DAY",
  TEAM_ATTENDANCE: "LOGIN",
  RELEASES: "RELEASE",
  RECAPTURE: "EMPLOYEE",
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
  TASKS: "TASK_ASSIGNED",
  DOCUMENTS: "DOCUMENT_TO_SIGN",
  ATTENDANCE: "ATTENDANCE_EXCEPTION",
  TEAM_ATTENDANCE: "TEAM_ATTENDANCE",
  RELEASES: "RELEASE_AVAILABLE",
  RECAPTURE: "FACE_RECAPTURE",
};

/** What a hand close is traced from: the kiosk for kiosk work, otherwise the person it is about (KEHOACH 9.24 rule 3). */
function tracedFrom(item: { queue: NoticeQueue; subjectId: string; employeeId: number | null }): Pick<AuditEntry, "subject" | "subjectId"> {
  return item.queue === "KIOSK"
    ? { subject: AUDIT_SUBJECTS.DEVICE, subjectId: item.subjectId }
    : { subject: AUDIT_SUBJECTS.EMPLOYEE, subjectId: String(item.employeeId) };
}

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
  lastMark?: number;
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
const RECURRING: ReadonlySet<NoticeQueue> = new Set<NoticeQueue>(["BACKUP", "KIOSK", "RECAPTURE"]);

/** What a reopening appends to the key of the closed work it moves aside: that work's close, in epoch milliseconds. */
export const CLOSED_STAMP = Prisma.sql`(extract(epoch FROM "closedAt") * 1000)::bigint`;

const CLOSED_STATES: readonly NoticeItemState[] = ["DONE", "WITHDRAWN", "EXPIRED", "CLEARED"];

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
  facts: Prisma.JsonValue;
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

/** The people whose open work a desk joins or leaves as its entities move from `from` to `to`; [] is the whole group. */
function movedPeople(from: string[], to: string[]): Prisma.EmployeeWhereInput {
  if (from.length === 0) {
    return { legalEntityId: { notIn: to } };
  }
  if (to.length === 0) {
    return { legalEntityId: { notIn: from } };
  }
  const moved = [...from.filter((id) => !to.includes(id)), ...to.filter((id) => !from.includes(id))];
  return { legalEntityId: { in: moved } };
}

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
      {
        subjectType: item.subjectType,
        subjectId: item.subjectId,
        subjectEmployeeId: item.employeeId,
        awaits: member && item.state === "OPEN",
      },
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
      resolvable: mayResolve(viewer, item),
      claimedByName: claimLive ? nameOf(item.claimedBy) : null,
      claimedAt: claimLive ? item.claimedAt : null,
      facts: item.facts,
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

  /** Close by hand with a note: work no business decision closes, or a day its own person lets go; audited (KEHOACH 9.21.4, 9.24).
   *  @ctx any | NOTICE_NOT_FOUND outside the group, NOTICE_ITEM_NOT_RESOLVABLE for work its own queue decides
   */
  async resolve(viewer: Viewer, key: string, note: string): Promise<ItemDetail> {
    const { item, member } = await this.reachable(viewer, key);
    if (!member) {
      throw new NotFoundException("NOTICE_NOT_FOUND");
    }
    if (!mayResolve(viewer, item)) {
      throw new ConflictException("NOTICE_ITEM_NOT_RESOLVABLE");
    }
    if (!(await this.shut(item.key, { state: "DONE", outcome: "RESOLVED", actorId: viewer.userId }))) {
      throw new ConflictException("NOTICE_ITEM_CLOSED");
    }
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.NOTICE_RESOLVE,
      ...tracedFrom(item),
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
        await this.retire([key]);
      }
      const made = await this.db.noticeItem.createMany({
        data: [
          {
            key,
            queue,
            subjectType: QUEUE_SUBJECT[queue],
            subjectId: subject.id,
            employeeId: subject.employeeId,
            level: opening.level ?? NOTICE_KINDS[QUEUE_KIND[queue]].level,
            facts: opening.facts,
            dueAt: opening.dueAt,
            lastMark: opening.lastMark,
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

  /** Move the closed work under these keys aside with its rows, keeping who handled it, so each key can open again.
   *  @ctx any | one statement; open work, and work closed in a state not listed, stays where it is
   */
  async retire(keys: string[], states: readonly NoticeItemState[] = CLOSED_STATES): Promise<void> {
    await this.db.$executeRaw`
      WITH old AS (
        UPDATE "NoticeItem" SET "key" = "key" || ':' || ${CLOSED_STAMP}
         WHERE "key" = ANY(${keys}::text[]) AND "state" <> 'OPEN' AND "state"::text = ANY(${[...states]}::text[])
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

  /** Recount, quietly as reconcile does, the open items about people a desk's entities brought into or out of reach (KEHOACH 9.4).
   *  @ctx job notice-rescope | throws, so the queue retries; reconcile repairs what it never finishes
   */
  async regroupRescoped(from: string[], to: string[]): Promise<void> {
    const items = await this.db.noticeItem.findMany({
      where: { state: "OPEN", queue: { notIn: ["DOCUMENTS", "ATTENDANCE", "RECAPTURE"] }, employee: { is: movedPeople(from, to) } },
    });
    for (const item of items) {
      await this.regroup(item, "quiet");
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
   *  @ctx any | the opening takes its mark in its insert, later marks are claimed on the item: each said once (KEHOACH 9.18)
   *  @param facts what the work carries from its opening, which every row seated on it copies
   */
  async speakDue(
    queue: "CONTRACTS_DUE" | "PROBATION_DUE" | "TASKS",
    subject: { id: string; employeeId: number },
    daysLeft: number,
    facts: Prisma.InputJsonObject = {},
  ): Promise<boolean> {
    const passed = (DUE_MARKS[queue] ?? []).filter((one) => daysLeft <= one).length;
    if (passed === 0) {
      return false;
    }
    const key = itemKey(queue, subject.id);
    const fresh = !(await this.db.noticeItem.findUnique({ where: { key }, select: { id: true } }));
    const opened = fresh && (await this.open(queue, subject, { facts, lastMark: passed }));
    if (!opened && !(await this.claimMark(queue, subject.id, passed))) {
      return false;
    }
    const warning = DUE_WARNING[queue];
    if (warning !== undefined && daysLeft <= warning) {
      await this.db.noticeItem.updateMany({ where: { key, state: "OPEN" }, data: { level: "WARNING" } });
    }
    // Work this call opened has just been told; a reminder on top would say one thing twice.
    if (opened) {
      await this.db.$executeRaw`
        UPDATE "Notification" n SET "facts" = n."facts" || ${JSON.stringify({ daysLeft })}::jsonb, "daysLeft" = ${daysLeft}::int
          FROM "NoticeItem" i
         WHERE n."itemId" = i."id" AND i."key" = ${key}
      `;
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
           SET "facts" = "facts" || ${JSON.stringify(count)}::jsonb,
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
        item.level,
      );
    } catch (fell) {
      this.log.error(`item ${key} was not reminded: ${String(fell)}`);
    }
  }

  private async reseat(item: NoticeItem, joining: Joining): Promise<{ seated: Seated[]; left: string[] }> {
    const audience = await this.audience.audienceOf(item.queue, item.subjectId, item.employeeId);
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
                                        "subjectEmployeeId", "dedupKey", "facts", "readAt", "approved")
            SELECT gen_random_uuid()::text, seat."userId", ${QUEUE_KIND[item.queue]}::"NoticeKind", i."id", i."subjectType",
                   i."subjectId", i."employeeId", i."key", i."facts", CASE WHEN ${quiet}::boolean THEN now() END,
                   CASE WHEN i."queue" = 'ADVANCES_TO_PAY' THEN true END
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
      await this.notices.announce(QUEUE_KIND[item.queue], seated.map((one) => ({ ...one, renotify: false })), item.level);
    }
    return { seated, left: left.map((one) => one.userId) };
  }
}
