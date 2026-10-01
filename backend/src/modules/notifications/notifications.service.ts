import { randomUUID } from "node:crypto";

import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  Prisma,
  type NoticeChannel,
  type NoticeItemState,
  type NoticeKind,
  type NoticeLevel,
  type NoticeOutcome,
  type NoticeSubject,
  type Notification,
  type NotificationPreference,
  type PushSubscription,
} from "@prisma/client";
import webpush from "web-push";

import { COUNT_CEILING, countedTo, nextCursor } from "../../common/dto/cursor.dto.js";
import type { Page } from "../../common/dto/pagination.dto.js";
import type { Env } from "../../config/env.schema.js";
import type { Viewer } from "../../common/scope/viewer.js";
import { PrismaService } from "../../database/prisma.service.js";
import { filedBetween, personWhere, resumeAfter, sortedBy } from "../leave/queue-filter.js";
import { FEED, RealtimeGateway } from "../realtime/realtime.gateway.js";
import type { SubscribeDto, SetPreferenceDto } from "./dto/notifications.dto.js";
import {
  factsFit,
  kebab,
  mutable,
  NOTICE_KINDS,
  receives,
  type NewsKind,
  type NoticeCategory,
  type OfferedChannel,
} from "./notice-kinds.js";
import { SubjectsService, type SubjectView } from "./subjects.service.js";

/** What a notice may carry: references and counts, never words or money. */
export interface NoticeFacts {
  requestId?: string;
  advanceId?: string;
  periodId?: string;
  payslipId?: string;
  contractId?: string;
  certificateId?: string;
  profileChangeId?: string;
  dependentId?: string;
  disputeId?: string;
  daysLeft?: number;
  daysWaited?: number;
  approved?: boolean;
  outcome?: NoticeOutcome;
}

// The first reference present names the subject; an answered dispute carries its slip as well.
const SUBJECT_REFS: readonly (readonly [keyof NoticeFacts, NoticeSubject])[] = [
  ["requestId", "REQUEST"],
  ["advanceId", "ADVANCE"],
  ["certificateId", "CERTIFICATE"],
  ["profileChangeId", "PROFILE_CHANGE"],
  ["dependentId", "DEPENDENT"],
  ["disputeId", "DISPUTE"],
  ["payslipId", "PAYSLIP"],
  ["contractId", "CONTRACT"],
];

/** The facts a kind declares, read off the references a caller passed (KEHOACH 9.21.4). */
function storedFacts(kind: NoticeKind, facts: NoticeFacts): Record<string, unknown> {
  const declared = NOTICE_KINDS[kind].facts;
  const decided =
    facts.outcome ??
    (facts.approved === undefined ? undefined : !facts.approved ? "REJECTED" : facts.certificateId ? "ISSUED" : "APPROVED");
  const held: Record<string, unknown> = {};
  if ("outcome" in declared && decided !== undefined) {
    held.outcome = decided;
  }
  if ("daysWaited" in declared && facts.daysWaited !== undefined) {
    held.daysWaited = facts.daysWaited;
  }
  if ("daysLeft" in declared && facts.daysLeft !== undefined) {
    held.daysLeft = facts.daysLeft;
  }
  return held;
}

export type SubscriptionView = Omit<PushSubscription, "p256dh" | "auth">;

/** The shared state a row of work shows, so every holder reads who handled it and who is on it (KEHOACH 9.21.4). */
export interface ItemSummary {
  key: string;
  level: NoticeLevel;
  state: NoticeItemState;
  outcome: NoticeOutcome | null;
  actorName: string | null;
  closedAt: Date | null;
  claimedByName: string | null;
  dueAt: Date | null;
}

type RawSubject = "subjectType" | "subjectId" | "subjectEmployeeId" | "dedupKey";

export type NoticeRow = Omit<Notification, RawSubject> & {
  category: NoticeCategory;
  item: ItemSummary | null;
  subject: SubjectView | null;
};

// A hidden subject must not leave a way in through the references the bell still reads (KEHOACH 9.21.4).
const REFERENCES = [
  "requestId",
  "advanceId",
  "periodId",
  "payslipId",
  "contractId",
  "certificateId",
  "profileChangeId",
  "dependentId",
] as const satisfies readonly (keyof Notification)[];

export type NoticeStatus = "unread" | "action" | "all" | "archived";

/** The view a reader filters the bell by; every field narrows, none widens. */
export interface NoticeFilter {
  status?: NoticeStatus;
  category?: NoticeCategory;
  from?: string;
  to?: string;
  search?: string;
}

export interface NoticeCounts {
  unread: number;
  action: number;
  critical: number;
}

export type MarkAction = "read" | "unread" | "archive" | "unarchive";

/** One of three ways to name rows: their ids, every row of a filter, or every row about one record. */
export interface MarkSelection extends NoticeFilter {
  ids?: string[];
  all?: boolean;
  subject?: { type: NoticeSubject; id: string };
}

export interface Unread {
  total: number;
}

export const NAMED = { select: { email: true, employee: { select: { fullName: true } } } } satisfies Prisma.UserDefaultArgs;

export function nameOf(login: { email: string; employee: { fullName: string } | null } | null): string | null {
  return login ? (login.employee?.fullName ?? login.email) : null;
}

const ITEM_SUMMARY = {
  key: true,
  level: true,
  state: true,
  outcome: true,
  closedAt: true,
  claimedAt: true,
  dueAt: true,
  actor: NAMED,
  claimedBy: NAMED,
} satisfies Prisma.NoticeItemSelect;

// Left rows still list, to read as moved; they count nowhere (KEHOACH 9.21.4).
const STATUS_WHERE: Record<NoticeStatus, Prisma.NotificationWhereInput> = {
  unread: { readAt: null, archivedAt: null, leftAt: null },
  action: { leftAt: null, item: { is: { state: "OPEN" } } },
  all: { archivedAt: null },
  archived: { archivedAt: { not: null } },
};

const MARKS: Record<MarkAction, { only: Prisma.NotificationWhereInput; data: (now: Date) => Prisma.NotificationUpdateManyMutationInput }> = {
  read: { only: { readAt: null }, data: (now) => ({ readAt: now }) },
  unread: { only: { readAt: { not: null } }, data: () => ({ readAt: null }) },
  archive: { only: { archivedAt: null }, data: (now) => ({ archivedAt: now }) },
  unarchive: { only: { archivedAt: { not: null } }, data: () => ({ archivedAt: null }) },
};

const kHourMs = 3_600_000;

export interface PreferenceRow {
  kind: NoticeKind;
  channel: NoticeChannel;
  on: boolean;
  mutable: boolean;
}

// Email stays in the enum for rows already written, but it is not a switch:
// letters ride their own errand (KEHOACH 9.21.4).
const OFFERED: readonly OfferedChannel[] = ["IN_APP", "PUSH"];

const kDeadSubscription = [404, 410];
const kBatch = 1000;

@Injectable()
export class NotificationsService {
  private readonly log = new Logger(NotificationsService.name);
  private readonly pushable: boolean;

  constructor(
    private readonly db: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly feed: RealtimeGateway,
    private readonly subjects: SubjectsService,
  ) {
    const publicKey = this.config.get("VAPID_PUBLIC_KEY", { infer: true });
    const privateKey = this.config.get("VAPID_PRIVATE_KEY", { infer: true });
    this.pushable = Boolean(publicKey && privateKey);
    if (this.pushable && publicKey && privateKey) {
      webpush.setVapidDetails(
        this.config.get("VAPID_SUBJECT", { infer: true }),
        publicKey,
        privateKey,
      );
    } else {
      this.log.warn("no VAPID keys: push is off, the in-app bell still works");
    }
  }

  /** The viewer's own rows under a filter, newest first, each with its item and its subject as the viewer may see it.
   *  @ctx any | resumes after a cursor; counts up to the ceiling
   */
  async list(viewer: Viewer, query: NoticeFilter & { cursor?: string; take: number }): Promise<Page<NoticeRow>> {
    const where = await this.filterWhere(viewer, query);
    const resumed = query.cursor
      ? { AND: [where, resumeAfter("createdAt", "desc", query.cursor) as Prisma.NotificationWhereInput] }
      : where;
    const [rows, found] = await Promise.all([
      this.db.notification.findMany({
        where: resumed,
        orderBy: sortedBy("createdAt", "desc") as Prisma.NotificationOrderByWithRelationInput[],
        take: query.take,
        include: { item: { select: ITEM_SUMMARY } },
      }),
      this.db.notification.count({ where, take: COUNT_CEILING + 1 }),
    ]);
    return {
      rows: await this.shape(viewer, rows),
      ...countedTo(found),
      next: nextCursor(rows, query.take, (row) => row.createdAt),
    };
  }

  /** One of the viewer's own rows; anybody else's answers as missing. */
  async one(viewer: Viewer, id: string): Promise<NoticeRow> {
    const row = await this.db.notification.findFirst({
      where: { id, userId: viewer.userId },
      include: { item: { select: ITEM_SUMMARY } },
    });
    if (!row) {
      throw new NotFoundException("NOTICE_NOT_FOUND");
    }
    return (await this.shape(viewer, [row]))[0];
  }

  /** The bell's three numbers: unread rows, open work held, open critical work held (KEHOACH 9.21.4). */
  async counts(userId: string): Promise<NoticeCounts> {
    const [unread, action, critical] = await Promise.all([
      this.db.notification.count({ where: { userId, ...STATUS_WHERE.unread } }),
      this.db.notification.count({ where: { userId, ...STATUS_WHERE.action } }),
      this.db.notification.count({ where: { userId, leftAt: null, item: { is: { state: "OPEN", level: "CRITICAL" } } } }),
    ]);
    return { unread, action, critical };
  }

  async unread(userId: string): Promise<Unread> {
    return { total: (await this.counts(userId)).unread };
  }

  /** Read, unread, put away or bring back the viewer's own rows, named exactly one way.
   *  @ctx any | one UPDATE; rows of other accounts are never touched
   */
  async mark(
    viewer: Viewer,
    action: MarkAction,
    chosen: MarkSelection,
    session?: string,
  ): Promise<NoticeCounts & { changed: number }> {
    const forms = [chosen.ids !== undefined, chosen.all === true, chosen.subject !== undefined].filter(Boolean).length;
    if (forms !== 1) {
      throw new BadRequestException("SELECTION_INVALID");
    }
    const which: Prisma.NotificationWhereInput = chosen.ids
      ? { userId: viewer.userId, id: { in: chosen.ids } }
      : chosen.subject
        ? { userId: viewer.userId, subjectType: chosen.subject.type, subjectId: chosen.subject.id }
        : await this.filterWhere(viewer, chosen);
    const changed = await this.db.notification.updateMany({
      where: { AND: [which, MARKS[action].only] },
      data: MARKS[action].data(new Date()),
    });
    if (changed.count > 0) {
      this.feed.tell(viewer.userId, FEED.notice, { op: "read", ...(chosen.ids ? { ids: chosen.ids } : { all: true }) }, session);
    }
    return { changed: changed.count, ...(await this.counts(viewer.userId)) };
  }

  private async filterWhere(viewer: Viewer, filter: NoticeFilter): Promise<Prisma.NotificationWhereInput> {
    const parts: Prisma.NotificationWhereInput[] = [{ userId: viewer.userId }, STATUS_WHERE[filter.status ?? "all"]];
    if (filter.category) {
      parts.push({ kind: { in: (Object.keys(NOTICE_KINDS) as NoticeKind[]).filter((kind) => NOTICE_KINDS[kind].category === filter.category) } });
    }
    const filed = filedBetween("createdAt", filter, this.config.get("APP_TIMEZONE", { infer: true }));
    if (Object.keys(filed).length > 0) {
      parts.push(filed as Prisma.NotificationWhereInput);
    }
    const person = await personWhere(this.db, { search: filter.search });
    if (person) {
      parts.push(this.subjects.searchable(await this.subjects.reach(viewer), person));
    }
    return { AND: parts };
  }

  private async shape(
    viewer: Viewer,
    rows: (Notification & { item: Prisma.NoticeItemGetPayload<{ select: typeof ITEM_SUMMARY }> | null })[],
  ): Promise<NoticeRow[]> {
    const subjects = await this.subjects.describe(viewer, rows);
    const lapsed = Date.now() - this.config.get("NOTICE_CLAIM_HOURS", { infer: true }) * kHourMs;
    return rows.map(({ item, subjectType: _type, subjectId: _id, subjectEmployeeId: _person, dedupKey: _key, ...row }, at) => ({
      ...row,
      ...(subjects[at]?.hidden ? Object.fromEntries(REFERENCES.map((ref) => [ref, null])) : {}),
      category: NOTICE_KINDS[row.kind].category,
      item: item && {
        key: item.key,
        level: item.level,
        state: item.state,
        outcome: item.outcome,
        closedAt: item.closedAt,
        dueAt: item.dueAt,
        actorName: nameOf(item.actor),
        claimedByName: item.claimedAt && item.claimedAt.getTime() > lapsed ? nameOf(item.claimedBy) : null,
      },
      subject: subjects[at],
    }));
  }

  /** Only the kinds this account can receive, each switch saying whether it may turn (KEHOACH 9.21.4). */
  async preferences(viewer: Viewer): Promise<PreferenceRow[]> {
    const held = await this.db.notificationPreference.findMany({ where: { userId: viewer.userId } });
    const known = new Map(held.map((row) => [`${row.kind}:${row.channel}`, row.on]));
    return (Object.keys(NOTICE_KINDS) as NoticeKind[])
      .filter((kind) => receives(kind, viewer.role, viewer.employeeId !== null))
      .flatMap((kind) =>
        OFFERED.map((channel) => ({
          kind,
          channel,
          on: mutable(kind, channel) ? (known.get(`${kind}:${channel}`) ?? NOTICE_KINDS[kind].defaults[channel]) : true,
          mutable: mutable(kind, channel),
        })),
      );
  }

  async setPreference(viewer: Viewer, body: SetPreferenceDto): Promise<NotificationPreference> {
    if (!receives(body.kind, viewer.role, viewer.employeeId !== null)) {
      throw new NotFoundException("NOTICE_NOT_FOUND");
    }
    if (!mutable(body.kind, body.channel as OfferedChannel)) {
      throw new ConflictException("NOTICE_CHANNEL_LOCKED");
    }
    return this.db.notificationPreference.upsert({
      where: {
        userId_kind_channel: { userId: viewer.userId, kind: body.kind, channel: body.channel },
      },
      update: { on: body.on },
      create: { userId: viewer.userId, kind: body.kind, channel: body.channel, on: body.on },
    });
  }

  /** Keep a browser's push subscription: only on a known push service, and an endpoint another
   *  account holds never changes owner (KEHOACH 7.2).
   */
  async subscribe(userId: string, body: SubscribeDto): Promise<SubscriptionView> {
    if (!this.pushService(body.endpoint)) {
      throw new BadRequestException("PUSH_ENDPOINT_REFUSED");
    }
    const held = await this.db.pushSubscription.findUnique({ where: { endpoint: body.endpoint } });
    if (held && held.userId !== userId) {
      throw new ConflictException("PUSH_ENDPOINT_TAKEN");
    }
    const kept = await this.db.pushSubscription.upsert({
      where: { endpoint: body.endpoint },
      update: { p256dh: body.p256dh, auth: body.auth, userAgent: body.userAgent ?? null },
      create: {
        userId,
        endpoint: body.endpoint,
        p256dh: body.p256dh,
        auth: body.auth,
        userAgent: body.userAgent ?? null,
      },
    });
    const { p256dh: _key, auth: _secret, ...shown } = kept;
    return shown;
  }

  private pushService(endpoint: string): boolean {
    let url: URL;
    try {
      url = new URL(endpoint);
    } catch {
      return false;
    }
    const host = url.hostname.toLowerCase();
    return (
      url.protocol === "https:" &&
      this.config.get("PUSH_ENDPOINT_HOSTS", { infer: true }).some((allowed) =>
        allowed.startsWith(".") ? host.endsWith(allowed) : host === allowed,
      )
    );
  }

  /** The devices this account receives push on, newest first, without their keys. */
  async subscriptions(userId: string): Promise<SubscriptionView[]> {
    const rows = await this.db.pushSubscription.findMany({ where: { userId }, orderBy: { createdAt: "desc" } });
    return rows.map(({ p256dh: _key, auth: _secret, ...shown }) => shown);
  }

  /** Drop one of the viewer's own devices by its id; another account's answers as missing. */
  async dropSubscription(userId: string, id: string): Promise<void> {
    const gone = await this.db.pushSubscription.deleteMany({ where: { id, userId } });
    if (gone.count === 0) {
      throw new NotFoundException("NOTICE_NOT_FOUND");
    }
  }

  /** Only the owner drops a device: the endpoint alone is a guessable name for
   *  somebody else's phone (KEHOACH 9.4).
   */
  async unsubscribe(viewer: Viewer, endpoint: string | undefined): Promise<void> {
    // An empty endpoint must not read as "every device this account has".
    if (!endpoint) {
      throw new BadRequestException("PUSH_ENDPOINT_REQUIRED");
    }
    await this.db.pushSubscription.deleteMany({
      where: { endpoint, userId: viewer.userId },
    });
  }

  /** Tell the login this person signs in with, if they have one that is open. Callers
   *  work in employees; only the bell works in logins (KEHOACH 9.21.4).
   */
  async raiseFor(employeeId: number, kind: NewsKind, facts: NoticeFacts): Promise<void> {
    await this.raiseEachFor(kind, [{ employeeId, facts }]);
  }

  /** Each person's open login, told with that person's own references, such as their own payslip. */
  async raiseEachFor(kind: NewsKind, sends: { employeeId: number; facts: NoticeFacts }[]): Promise<void> {
    const factsOf = new Map(sends.map((one) => [one.employeeId, one.facts]));
    const logins = await this.db.user.findMany({
      where: { employeeId: { in: [...factsOf.keys()] }, active: true },
      select: { id: true, employeeId: true },
    });
    if (logins.length < factsOf.size) {
      this.log.warn(`notice ${kind}: ${factsOf.size - logins.length} of ${factsOf.size} people have no open login`);
    }
    await this.raiseEach(
      kind,
      logins.flatMap((one) => {
        const facts = one.employeeId === null ? undefined : factsOf.get(one.employeeId);
        return facts ? [{ userId: one.id, employeeId: one.employeeId, facts }] : [];
      }),
    );
  }

  /** Raise a notice to one login that may have no employee record behind it. */
  async raise(userId: string, kind: NewsKind, facts: NoticeFacts): Promise<void> {
    await this.raiseEach(kind, [{ userId, employeeId: null, facts }]);
  }

  /**
   * One row per login and subject: written again with other facts it surfaces as unread, with the
   * same facts nothing changes. Failing here never undoes what it describes (KEHOACH 9.21.4).
   */
  async raiseEach(kind: NewsKind, sends: { userId: string; employeeId: number | null; facts: NoticeFacts }[]): Promise<void> {
    if (sends.length === 0) {
      return;
    }
    try {
      if (NOTICE_KINDS[kind].item) {
        throw new Error(`${kind} is work a group shares; NoticeItemsService opens it`);
      }
      const wants = await this.channelsFor(kind, sends.map((one) => one.userId));
      const landed: { id: string; userId: string }[] = [];
      // Twenty parameters a row: a thousand rows stay far under the 65,535 one statement takes.
      for (let at = 0; at < sends.length; at += kBatch) {
        const rows = sends.slice(at, at + kBatch).map((one) => this.newsRow(kind, one, !wants(one.userId, "IN_APP")));
        landed.push(
          ...(await this.db.$queryRaw<{ id: string; userId: string }[]>`
            INSERT INTO "Notification" ("id", "userId", "kind", "subjectType", "subjectId", "subjectEmployeeId",
                                        "dedupKey", "facts", "archivedAt", "requestId", "advanceId", "periodId",
                                        "payslipId", "contractId", "certificateId", "profileChangeId", "dependentId",
                                        "daysLeft", "daysWaited", "approved")
            VALUES ${Prisma.join(rows)}
            ON CONFLICT ("userId", "dedupKey") DO UPDATE
               SET "facts" = EXCLUDED."facts", "daysLeft" = EXCLUDED."daysLeft", "daysWaited" = EXCLUDED."daysWaited",
                   "readAt" = NULL, "remindCount" = "Notification"."remindCount" + 1, "remindedAt" = now(),
                   "archivedAt" = CASE WHEN EXCLUDED."archivedAt" IS NULL THEN NULL
                                       ELSE COALESCE("Notification"."archivedAt", EXCLUDED."archivedAt") END
             WHERE "Notification"."facts" IS DISTINCT FROM EXCLUDED."facts"
            RETURNING "id", "userId"
          `),
        );
      }
      const factsOf = new Map(sends.map((one) => [one.userId, one.facts]));
      await this.announce(
        kind,
        landed
          .filter((one) => wants(one.userId, "IN_APP"))
          .map((one) => ({ ...one, facts: factsOf.get(one.userId) ?? {} })),
      );
    } catch (fell) {
      this.log.error(`notices ${kind} were not raised: ${String(fell)}`);
    }
  }

  /** Tell each login's open screens of a row it just got, and push it where the person allows. */
  async announce(kind: NoticeKind, rows: { id: string; userId: string; facts: NoticeFacts }[]): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    const wants = await this.channelsFor(kind, rows.map((one) => one.userId));
    for (const one of rows) {
      this.feed.tell(one.userId, FEED.notice, { op: "new", id: one.id, kind, category: NOTICE_KINDS[kind].category });
    }
    await Promise.all(
      rows.filter((one) => wants(one.userId, "PUSH")).map((one) => this.push(one.userId, kind, one.facts)),
    );
  }

  /** Whether a login takes a kind on a channel. Each channel answers for itself: one switch never speaks for the other. */
  private async channelsFor(
    kind: NoticeKind,
    userIds: string[],
  ): Promise<(userId: string, channel: OfferedChannel) => boolean> {
    const held = await this.db.notificationPreference.findMany({
      where: { userId: { in: userIds }, kind, channel: { in: [...OFFERED] } },
      select: { userId: true, channel: true, on: true },
    });
    const set = new Map(held.map((row) => [`${row.userId}:${row.channel}`, row.on]));
    return (userId, channel) =>
      !mutable(kind, channel) || (set.get(`${userId}:${channel}`) ?? NOTICE_KINDS[kind].defaults[channel]);
  }

  private newsRow(
    kind: NewsKind,
    send: { employeeId: number | null; userId: string; facts: NoticeFacts },
    muted: boolean,
  ): Prisma.Sql {
    const id = randomUUID();
    const facts = send.facts;
    const subject = SUBJECT_REFS.find(([ref]) => typeof facts[ref] === "string");
    const subjectType = subject ? subject[1] : null;
    const subjectId = subject ? (facts[subject[0]] as string) : null;
    const dedupKey = subject ? `${kebab(kind)}:${kebab(subject[1])}:${subjectId}` : `${kebab(kind)}:row:${id}`;
    const stored = storedFacts(kind, facts);
    if (!factsFit(kind, stored)) {
      throw new Error(`facts ${JSON.stringify(stored)} do not fit ${kind}`);
    }
    return Prisma.sql`(
      ${id}, ${send.userId}, ${kind}::"NoticeKind", ${subjectType}::"NoticeSubject", ${subjectId}::text,
      ${send.employeeId}::int, ${dedupKey}, ${JSON.stringify(stored)}::jsonb,
      CASE WHEN ${muted}::boolean THEN now() END, ${facts.requestId ?? null}::text, ${facts.advanceId ?? null}::text,
      ${facts.periodId ?? null}::text, ${facts.payslipId ?? null}::text, ${facts.contractId ?? null}::text,
      ${facts.certificateId ?? null}::text, ${facts.profileChangeId ?? null}::text, ${facts.dependentId ?? null}::text,
      ${facts.daysLeft ?? null}::int, ${facts.daysWaited ?? null}::int, ${facts.approved ?? null}::boolean
    )`;
  }

  private async push(userId: string, kind: NoticeKind, facts: NoticeFacts): Promise<void> {
    if (!this.pushable) {
      return;
    }
    const [subs, who] = await Promise.all([
      this.db.pushSubscription.findMany({ where: { userId } }),
      this.db.user.findUnique({ where: { id: userId }, select: { employee: { select: { locale: true } } } }),
    ]);
    // A kind, some references and a language tag: the device builds the words,
    // so no amount can reach a lock screen.
    const body = JSON.stringify({ kind, locale: who?.employee?.locale ?? "vi", ...facts });
    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          body,
        );
        await this.db.pushSubscription.update({
          where: { id: sub.id },
          data: { lastSentAt: new Date() },
        });
      } catch (fell) {
        const code = (fell as { statusCode?: number }).statusCode;
        if (code !== undefined && kDeadSubscription.includes(code)) {
          await this.db.pushSubscription.delete({ where: { id: sub.id } });
          this.log.log(`dropped a dead subscription for ${userId}`);
        } else {
          this.log.warn(`push to ${userId} failed: ${String(fell)}`);
        }
      }
    }
  }
}
