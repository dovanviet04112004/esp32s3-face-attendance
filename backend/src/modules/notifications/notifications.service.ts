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

// Email is off by default everywhere: a payslip already has its own mail path
// at KEHOACH 9.11, and turning it on here would send the news twice.
const DEFAULT_ON: Record<NoticeChannel, boolean> = {
  IN_APP: true,
  PUSH: true,
  EMAIL: false,
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

  list(employeeId: number, unreadOnly: boolean): Promise<Notification[]> {
    return this.db.notification.findMany({
      where: { employeeId, ...(unreadOnly ? { readAt: null } : {}) },
      orderBy: { createdAt: "desc" },
      take: kPageSize,
    });
  }

  async unread(employeeId: number): Promise<Unread> {
    return { total: await this.db.notification.count({ where: { employeeId, readAt: null } }) };
  }

  async markRead(employeeId: number, id?: string): Promise<Unread> {
    await this.db.notification.updateMany({
      where: { employeeId, readAt: null, ...(id ? { id } : {}) },
      data: { readAt: new Date() },
    });
    return this.unread(employeeId);
  }

  async preferences(employeeId: number): Promise<{ kind: NoticeKind; channel: NoticeChannel; on: boolean }[]> {
    const held = await this.db.notificationPreference.findMany({ where: { employeeId } });
    const known = new Map(held.map((row) => [`${row.kind}:${row.channel}`, row.on]));
    const channels: NoticeChannel[] = ["IN_APP", "PUSH", "EMAIL"];
    return KINDS.flatMap((kind) =>
      channels.map((channel) => ({
        kind,
        channel,
        on: known.get(`${kind}:${channel}`) ?? DEFAULT_ON[channel],
      })),
    );
  }

  setPreference(employeeId: number, body: SetPreferenceDto): Promise<unknown> {
    return this.db.notificationPreference.upsert({
      where: {
        employeeId_kind_channel: { employeeId, kind: body.kind, channel: body.channel },
      },
      update: { on: body.on },
      create: { employeeId, kind: body.kind, channel: body.channel, on: body.on },
    });
  }

  subscribe(employeeId: number, body: SubscribeDto): Promise<unknown> {
    return this.db.pushSubscription.upsert({
      where: { endpoint: body.endpoint },
      update: { employeeId, p256dh: body.p256dh, auth: body.auth, userAgent: body.userAgent ?? null },
      create: {
        employeeId,
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
    if (viewer.employeeId === null) {
      return;
    }
    await this.db.pushSubscription.deleteMany({
      where: { endpoint, employeeId: viewer.employeeId },
    });
  }

  /**
   * Raise a notice. Failing here never undoes the thing it describes, which is
   * the same bargain AuditService makes (KEHOACH 9.21.4).
   */
  async raise(employeeId: number, kind: NoticeKind, facts: NoticeFacts): Promise<void> {
    try {
      const wanted = await this.wants(employeeId, kind);
      if (wanted.IN_APP) {
        await this.db.notification.create({ data: { employeeId, kind, ...facts } });
      }
      if (wanted.PUSH) {
        await this.push(employeeId, kind, facts);
      }
    } catch (fell) {
      this.log.error(`notice ${kind} for ${employeeId} was not raised: ${String(fell)}`);
    }
  }

  /** One notice each, for a list of people, without a query per person. */
  async raiseMany(employeeIds: number[], kind: NoticeKind, facts: NoticeFacts): Promise<void> {
    if (employeeIds.length === 0) {
      return;
    }
    try {
      // Each channel answers for itself, as 9.21.4 asks: one switch must not
      // speak for the other in either direction.
      const held = await this.db.notificationPreference.findMany({
        where: { employeeId: { in: employeeIds }, kind, channel: { in: ["IN_APP", "PUSH"] } },
        select: { employeeId: true, channel: true, on: true },
      });
      const set = new Map(held.map((row) => [`${row.employeeId}:${row.channel}`, row.on]));
      const wants = (id: number, channel: NoticeChannel): boolean =>
        set.get(`${id}:${channel}`) ?? DEFAULT_ON[channel];
      const rows: Prisma.NotificationCreateManyInput[] = employeeIds
        .filter((id) => wants(id, "IN_APP"))
        .map((employeeId) => ({ employeeId, kind, ...facts }));
      if (rows.length > 0) {
        await this.db.notification.createMany({ data: rows });
      }
      await Promise.all(
        employeeIds.filter((id) => wants(id, "PUSH")).map((id) => this.push(id, kind, facts)),
      );
    } catch (fell) {
      this.log.error(`notices ${kind} were not raised: ${String(fell)}`);
    }
  }

  private async wants(
    employeeId: number,
    kind: NoticeKind,
  ): Promise<Record<NoticeChannel, boolean>> {
    const held = await this.db.notificationPreference.findMany({ where: { employeeId, kind } });
    const known = new Map(held.map((row) => [row.channel, row.on]));
    return {
      IN_APP: known.get("IN_APP") ?? DEFAULT_ON.IN_APP,
      PUSH: known.get("PUSH") ?? DEFAULT_ON.PUSH,
      EMAIL: known.get("EMAIL") ?? DEFAULT_ON.EMAIL,
    };
  }

  private async push(employeeId: number, kind: NoticeKind, facts: NoticeFacts): Promise<void> {
    if (!this.pushable) {
      return;
    }
    const [subs, who] = await Promise.all([
      this.db.pushSubscription.findMany({ where: { employeeId } }),
      this.db.employee.findUnique({ where: { id: employeeId }, select: { locale: true } }),
    ]);
    // A kind, some references and a language tag: the device builds the words,
    // so no amount can reach a lock screen.
    const body = JSON.stringify({ kind, locale: who?.locale ?? "vi", ...facts });
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
          this.log.log(`dropped a dead subscription for ${employeeId}`);
        } else {
          this.log.warn(`push to ${employeeId} failed: ${String(fell)}`);
        }
      }
    }
  }
}
