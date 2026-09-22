import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { NoticeChannel, NoticeKind, Notification, Prisma } from "@prisma/client";
import webpush from "web-push";

import type { Env } from "../../config/env.schema.js";
import type { Viewer } from "../../common/scope/viewer.js";
import { PrismaService } from "../../database/prisma.service.js";
import type { SubscribeDto, SetPreferenceDto } from "./dto/notifications.dto.js";

/** What a notice may carry: references and counts, never words or money. */
export interface NoticeFacts {
  requestId?: string;
  periodId?: string;
  payslipId?: string;
  contractId?: string;
  daysLeft?: number;
  daysWaited?: number;
  approved?: boolean;
}

export interface Unread {
  total: number;
}

const KINDS: NoticeKind[] = [
  "REQUEST_DECIDED",
  "REQUEST_WAITING",
  "REQUEST_STALLED",
  "PAYSLIP_ISSUED",
  "CONTRACT_ENDING",
  "DISPUTE_ANSWERED",
];

// Email stays in the enum for rows already written, but it is not a switch:
// letters ride their own errand (KEHOACH 9.21.4).
const OFFERED = ["IN_APP", "PUSH"] as const;

type OfferedChannel = (typeof OFFERED)[number];

const DEFAULT_ON: Record<OfferedChannel, boolean> = {
  IN_APP: true,
  PUSH: true,
};

const kDeadSubscription = [404, 410];
const kPageSize = 50;

@Injectable()
export class NotificationsService {
  private readonly log = new Logger(NotificationsService.name);
  private readonly pushable: boolean;

  constructor(
    private readonly db: PrismaService,
    private readonly config: ConfigService<Env, true>,
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
      where: { userId, ...(unreadOnly ? { readAt: null } : {}) },
      orderBy: { createdAt: "desc" },
      take: kPageSize,
    });
  }

  async unread(userId: string): Promise<Unread> {
    return { total: await this.db.notification.count({ where: { userId, readAt: null } }) };
  }

  async markRead(userId: string, id?: string): Promise<Unread> {
    await this.db.notification.updateMany({
      where: { userId, readAt: null, ...(id ? { id } : {}) },
      data: { readAt: new Date() },
    });
    return this.unread(userId);
  }

  async preferences(userId: string): Promise<{ kind: NoticeKind; channel: NoticeChannel; on: boolean }[]> {
    const held = await this.db.notificationPreference.findMany({ where: { userId } });
    const known = new Map(held.map((row) => [`${row.kind}:${row.channel}`, row.on]));
    return KINDS.flatMap((kind) =>
      OFFERED.map((channel) => ({
        kind,
        channel,
        on: known.get(`${kind}:${channel}`) ?? DEFAULT_ON[channel],
      })),
    );
  }

  setPreference(userId: string, body: SetPreferenceDto): Promise<unknown> {
    return this.db.notificationPreference.upsert({
      where: {
        userId_kind_channel: { userId, kind: body.kind, channel: body.channel },
      },
      update: { on: body.on },
      create: { userId, kind: body.kind, channel: body.channel, on: body.on },
    });
  }

  subscribe(userId: string, body: SubscribeDto): Promise<unknown> {
    return this.db.pushSubscription.upsert({
      where: { endpoint: body.endpoint },
      update: { userId, p256dh: body.p256dh, auth: body.auth, userAgent: body.userAgent ?? null },
      create: {
        userId,
        endpoint: body.endpoint,
        p256dh: body.p256dh,
        auth: body.auth,
        userAgent: body.userAgent ?? null,
      },
    });
  }

  /** Only the owner drops a device: the endpoint alone is a guessable name for
   *  somebody else's phone (KEHOACH 9.4).
   */
  async unsubscribe(viewer: Viewer, endpoint: string): Promise<void> {
    await this.db.pushSubscription.deleteMany({
      where: { endpoint, userId: viewer.userId },
    });
  }

  /** Tell the login this person signs in with, if they have one. Callers work
   *  in employees; only the bell works in logins (KEHOACH 9.21.4).
   */
  async raiseFor(employeeId: number, kind: NoticeKind, facts: NoticeFacts): Promise<void> {
    const login = await this.db.user.findUnique({ where: { employeeId }, select: { id: true } });
    if (!login) {
      this.log.warn(`notice ${kind} has no login to reach for employee ${employeeId}`);
      return;
    }
    await this.raise(login.id, kind, facts);
  }

  async raiseManyFor(employeeIds: number[], kind: NoticeKind, facts: NoticeFacts): Promise<void> {
    const logins = await this.db.user.findMany({
      where: { employeeId: { in: employeeIds }, active: true },
      select: { id: true },
    });
    await this.raiseMany(logins.map((one) => one.id), kind, facts);
  }

  /**
   * Raise a notice. Failing here never undoes the thing it describes, which is
   * the same bargain AuditService makes (KEHOACH 9.21.4).
   */
  async raise(userId: string, kind: NoticeKind, facts: NoticeFacts): Promise<void> {
    try {
      const wanted = await this.wants(userId, kind);
      if (wanted.IN_APP) {
        await this.db.notification.create({ data: { userId, kind, ...facts } });
      }
      if (wanted.PUSH) {
        await this.push(userId, kind, facts);
      }
    } catch (fell) {
      this.log.error(`notice ${kind} for ${userId} was not raised: ${String(fell)}`);
    }
  }

  /** One notice each, for a list of people, without a query per person. */
  async raiseMany(userIds: string[], kind: NoticeKind, facts: NoticeFacts): Promise<void> {
    if (userIds.length === 0) {
      return;
    }
    try {
      // Each channel answers for itself, as 9.21.4 asks: one switch must not
      // speak for the other in either direction.
      const held = await this.db.notificationPreference.findMany({
        where: { userId: { in: userIds }, kind, channel: { in: ["IN_APP", "PUSH"] } },
        select: { userId: true, channel: true, on: true },
      });
      const set = new Map(held.map((row) => [`${row.userId}:${row.channel}`, row.on]));
      const wants = (id: string, channel: OfferedChannel): boolean =>
        set.get(`${id}:${channel}`) ?? DEFAULT_ON[channel];
      const rows: Prisma.NotificationCreateManyInput[] = userIds
        .filter((id) => wants(id, "IN_APP"))
        .map((one) => ({ userId: one, kind, ...facts }));
      if (rows.length > 0) {
        // One batch, then one at a time if it falls: an account closed between
        // reading the list and writing it must not silence everybody else.
        await this.db.notification.createMany({ data: rows }).catch(async () => {
          for (const row of rows) {
            await this.db.notification.create({ data: row }).catch(() => undefined);
          }
        });
      }
      await Promise.all(
        userIds.filter((id) => wants(id, "PUSH")).map((id) => this.push(id, kind, facts)),
      );
    } catch (fell) {
      this.log.error(`notices ${kind} were not raised: ${String(fell)}`);
    }
  }

  private async wants(
    userId: string,
    kind: NoticeKind,
  ): Promise<Record<OfferedChannel, boolean>> {
    const held = await this.db.notificationPreference.findMany({ where: { userId, kind } });
    const known = new Map(held.map((row) => [row.channel, row.on]));
    return {
      IN_APP: known.get("IN_APP") ?? DEFAULT_ON.IN_APP,
      PUSH: known.get("PUSH") ?? DEFAULT_ON.PUSH,
    };
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
