import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type {
  NoticeChannel,
  NoticeKind,
  Notification,
  NotificationPreference,
  Prisma,
  PushSubscription,
  Role,
} from "@prisma/client";
import webpush from "web-push";

import type { Env } from "../../config/env.schema.js";
import type { Viewer } from "../../common/scope/viewer.js";
import { PrismaService } from "../../database/prisma.service.js";
import { FEED, RealtimeGateway } from "../realtime/realtime.gateway.js";
import type { SubscribeDto, SetPreferenceDto } from "./dto/notifications.dto.js";
import { mutable, NOTICE_KINDS, receives, type OfferedChannel } from "./notice-kinds.js";

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
  daysLeft?: number;
  daysWaited?: number;
  approved?: boolean;
}

export type SubscriptionView = Omit<PushSubscription, "p256dh" | "auth">;

export interface Unread {
  total: number;
}

export interface PreferenceRow {
  kind: NoticeKind;
  channel: NoticeChannel;
  on: boolean;
  mutable: boolean;
}

// Email stays in the enum for rows already written, but it is not a switch:
// letters ride their own errand (KEHOACH 9.21.4).
const OFFERED: readonly OfferedChannel[] = ["IN_APP", "PUSH"];

// A row the bell shows: neither put away nor left behind by a regrouped item.
const SHOWN = { archivedAt: null, leftAt: null } satisfies Prisma.NotificationWhereInput;

const kDeadSubscription = [404, 410];
const kPageSize = 50;

@Injectable()
export class NotificationsService {
  private readonly log = new Logger(NotificationsService.name);
  private readonly pushable: boolean;

  constructor(
    private readonly db: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly feed: RealtimeGateway,
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

  list(userId: string, unreadOnly: boolean): Promise<Notification[]> {
    return this.db.notification.findMany({
      where: { userId, ...SHOWN, ...(unreadOnly ? { readAt: null } : {}) },
      orderBy: { createdAt: "desc" },
      take: kPageSize,
    });
  }

  async unread(userId: string): Promise<Unread> {
    return { total: await this.db.notification.count({ where: { userId, readAt: null, ...SHOWN } }) };
  }

  async markRead(userId: string, id?: string): Promise<Unread> {
    await this.db.notification.updateMany({
      where: { userId, readAt: null, ...(id ? { id } : {}) },
      data: { readAt: new Date() },
    });
    return this.unread(userId);
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
  async raiseFor(employeeId: number, kind: NoticeKind, facts: NoticeFacts): Promise<void> {
    const login = await this.db.user.findUnique({
      where: { employeeId },
      select: { id: true, active: true },
    });
    if (!login?.active) {
      this.log.warn(`notice ${kind} has no open login to reach for employee ${employeeId}`);
      return;
    }
    await this.raise(login.id, kind, facts);
  }

  /** Tell every open login of a desk, minus the people the item is about or came from (KEHOACH 9.15). */
  async raiseToDesk(
    roles: Role[],
    kind: NoticeKind,
    facts: NoticeFacts,
    except: { employeeIds?: number[]; userIds?: string[] } = {},
  ): Promise<void> {
    const desk = await this.db.user.findMany({
      where: { active: true, role: { in: roles } },
      select: { id: true, employeeId: true },
    });
    const skipped = new Set(except.employeeIds ?? []);
    const skippedLogins = new Set(except.userIds ?? []);
    await this.raiseMany(
      desk
        .filter((one) => !skippedLogins.has(one.id) && (one.employeeId === null || !skipped.has(one.employeeId)))
        .map((one) => one.id),
      kind,
      facts,
    );
  }

  async raiseManyFor(employeeIds: number[], kind: NoticeKind, facts: NoticeFacts): Promise<void> {
    const logins = await this.db.user.findMany({
      where: { employeeId: { in: employeeIds }, active: true },
      select: { id: true },
    });
    await this.raiseMany(logins.map((one) => one.id), kind, facts);
  }

  /** Each person's open login, told with that person's own references, such as their own payslip. */
  async raiseEachFor(kind: NoticeKind, sends: { employeeId: number; facts: NoticeFacts }[]): Promise<void> {
    const factsOf = new Map(sends.map((one) => [one.employeeId, one.facts]));
    const logins = await this.db.user.findMany({
      where: { employeeId: { in: [...factsOf.keys()] }, active: true },
      select: { id: true, employeeId: true },
    });
    await this.raiseEach(
      kind,
      logins.flatMap((one) => {
        const facts = one.employeeId === null ? undefined : factsOf.get(one.employeeId);
        return facts ? [{ userId: one.id, facts }] : [];
      }),
    );
  }

  /**
   * Raise a notice. Failing here never undoes the thing it describes, which is
   * the same bargain AuditService makes (KEHOACH 9.21.4).
   */
  async raise(userId: string, kind: NoticeKind, facts: NoticeFacts): Promise<void> {
    await this.raiseEach(kind, [{ userId, facts }]);
  }

  /** One notice each, for a list of people, without a query per person. */
  async raiseMany(userIds: string[], kind: NoticeKind, facts: NoticeFacts): Promise<void> {
    await this.raiseEach(kind, userIds.map((userId) => ({ userId, facts })));
  }

  /** One notice per login, each with its own references, without a query per person. */
  async raiseEach(kind: NoticeKind, sends: { userId: string; facts: NoticeFacts }[]): Promise<void> {
    if (sends.length === 0) {
      return;
    }
    try {
      // Each channel answers for itself, as 9.21.4 asks: one switch must not
      // speak for the other in either direction.
      const held = await this.db.notificationPreference.findMany({
        where: { userId: { in: sends.map((one) => one.userId) }, kind, channel: { in: ["IN_APP", "PUSH"] } },
        select: { userId: true, channel: true, on: true },
      });
      const set = new Map(held.map((row) => [`${row.userId}:${row.channel}`, row.on]));
      const wants = (id: string, channel: OfferedChannel): boolean =>
        !mutable(kind, channel) || (set.get(`${id}:${channel}`) ?? NOTICE_KINDS[kind].defaults[channel]);
      const now = new Date();
      // Muted in the app, the row still lands, put away: it is the dedup and the record of whom it reached.
      const rows: Prisma.NotificationCreateManyInput[] = sends.map((one) => ({
        userId: one.userId,
        kind,
        ...one.facts,
        ...(wants(one.userId, "IN_APP") ? {} : { archivedAt: now }),
      }));
      if (rows.length > 0) {
        // One batch, then one at a time if it falls: an account closed between
        // reading the list and writing it must not silence everybody else.
        await this.db.notification.createMany({ data: rows }).catch(async () => {
          for (const row of rows) {
            await this.db.notification.create({ data: row }).catch(() => undefined);
          }
        });
      }
      const shown = sends.filter((one) => wants(one.userId, "IN_APP"));
      for (const one of shown) {
        this.feed.tell(one.userId, FEED.notice, { kind, ...one.facts });
      }
      await Promise.all(
        shown.filter((one) => wants(one.userId, "PUSH")).map((one) => this.push(one.userId, kind, one.facts)),
      );
    } catch (fell) {
      this.log.error(`notices ${kind} were not raised: ${String(fell)}`);
    }
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
