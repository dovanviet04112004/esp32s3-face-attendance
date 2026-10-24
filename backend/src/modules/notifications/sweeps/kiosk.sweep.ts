import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { OnEvent } from "@nestjs/event-emitter";

import type { DeviceEvent } from "../../../common/generated/device_event.js";
import type { Env } from "../../../config/env.schema.js";
import { PrismaService } from "../../../database/prisma.service.js";
import { QUEUE_TOKEN, type Queues } from "../../../queue/queue.module.js";
import { JOB, QUEUE } from "../../../queue/queues.js";
import { behind, UPDATE_FINISHED, type UpdateFinished } from "../../models/release-rules.js";
import { KIOSK_EVENT, type KioskMessage } from "../../mqtt/mqtt.events.js";
import { DEFAULT_MAIL_LOCALE, kioskSilentMail } from "../../payroll/mail-text.js";
import { localStamp } from "../../timesheet/local-day.js";
import { MailerService } from "../mailer.service.js";
import { itemKey, NoticeItemsService } from "../notice-items.service.js";
import { kebab, KIOSK_BOOT_SETTLE_MINUTES, KIOSK_BURST_QUIET_MINUTES } from "../notice-kinds.js";
import { ReleaseSweep } from "./release.sweep.js";

type Reported = DeviceEvent["type"];

/** What shows a fault mended: a settled boot, a face seen, a punch through, or a quiet online hour. */
type Proof = "boot" | "face" | "punch" | "quiet";

// Each fault clears itself on its own evidence (KEHOACH 9.21.4).
const FAULTS: Partial<Record<Reported, Proof>> = {
  DOOR_FAULT: "quiet",
  CAMERA_FAULT: "face",
  TOF_FAULT: "quiet",
  LCD_FAULT: "quiet",
  AUDIO_FAULT: "quiet",
  STORAGE_FAULT: "punch",
  FACEDB_CORRUPT: "boot",
  MODEL_LOAD_FAILED: "boot",
};
const FACE_RESULTS: readonly Reported[] = ["SPOOF_DETECTED", "UNKNOWN_FACE", "QUALITY_REJECTED"];
const UPDATE_FAILED: ReadonlySet<Reported> = new Set<Reported>(["OTA_FAILED", "OTA_ROLLED_BACK"]);
const BURSTS: Partial<Record<Reported, { part: string; code: string; limit: "KIOSK_SPOOF_BURST" | "KIOSK_UNKNOWN_BURST" }>> = {
  SPOOF_DETECTED: { part: "spoof", code: "SPOOF_BURST", limit: "KIOSK_SPOOF_BURST" },
  UNKNOWN_FACE: { part: "unknown", code: "UNKNOWN_BURST", limit: "KIOSK_UNKNOWN_BURST" },
};
const kWatchCron = "*/5 * * * *";
const kMinuteMs = 60_000;

interface Silent {
  id: string;
  name: string | null;
  location: string | null;
  lastSeenAt: Date | null;
}

/** A kiosk's own work for the ADMINs: waiting to join, silent past the limit, a fault, a failed update, a burst. */
@Injectable()
export class KioskSweep implements OnModuleInit {
  private readonly log = new Logger(KioskSweep.name);

  constructor(
    private readonly db: PrismaService,
    private readonly items: NoticeItemsService,
    private readonly releases: ReleaseSweep,
    private readonly mailer: MailerService,
    private readonly config: ConfigService<Env, true>,
    @Inject(QUEUE_TOKEN) private readonly queues: Queues,
  ) {}

  // Upserting by scheduler id: a restart re-states it, never adds a second.
  async onModuleInit(): Promise<void> {
    await this.queues[QUEUE.notify].upsertJobScheduler(
      "kiosk-alerts",
      { pattern: kWatchCron, tz: this.config.get("APP_TIMEZONE", { infer: true }) },
      { name: JOB.kioskAlerts, data: { type: JOB.kioskAlerts } },
    );
  }

  /** Close what came right, then open offline work for each kiosk in the fleet silent past the limit.
   *  @ctx job | every five minutes; one silence is said once, the ADMINs mailed until an address takes the letter
   */
  async sweep(now: Date = new Date()): Promise<{ opened: number; closed: number }> {
    const closed = await this.closeVanished(null, now);
    const minutes = this.config.get("KIOSK_OFFLINE_ALERT_MINUTES", { infer: true });
    const silent = await this.db.device.findMany({
      where: { status: "APPROVED", online: false, lastSeenAt: { lt: new Date(now.getTime() - minutes * kMinuteMs) } },
      select: { id: true, name: true, location: true, lastSeenAt: true },
    });
    let opened = 0;
    for (const device of silent) {
      const told = await this.toldSinceHeard(device);
      if (!told && (await this.items.open("KIOSK", { id: device.id, part: "offline", employeeId: null }, { level: "CRITICAL", facts: { code: "OFFLINE" } }))) {
        opened += 1;
      }
      await this.mailSilent(device, minutes);
    }
    this.log.log(`kiosks swept: ${opened} silent told, ${closed} closed`);
    return { opened, closed };
  }

  // The subject columns find this kiosk's work by their index; the key prefix only picks its silences, retired ones too.
  private async toldSinceHeard(device: Silent): Promise<boolean> {
    const told = await this.db.noticeItem.findFirst({
      where: {
        queue: "KIOSK",
        subjectType: "DEVICE",
        subjectId: device.id,
        key: { startsWith: itemKey("KIOSK", { id: device.id, part: "offline" }) },
        openedAt: { gt: device.lastSeenAt ?? new Date(0) },
      },
      select: { id: true },
    });
    return told !== null;
  }

  /** A kiosk asking to join is work for the ADMINs until somebody approves or revokes it.
   *  @ctx any | after the registration commit; logs its own failures
   */
  async pending(deviceId: string): Promise<void> {
    await this.items.open("KIOSK", { id: deviceId, part: "pending", employeeId: null }, { level: "ACTION", facts: { code: "PENDING" } });
  }

  /** Close a kiosk's request to join as approved or refused; a revoked kiosk clears its other work too.
   *  @ctx any | after the decision commit; logs its own failures
   */
  async decided(deviceId: string, status: "APPROVED" | "REVOKED", actorId: string): Promise<void> {
    const outcome = status === "APPROVED" ? "APPROVED" : "REJECTED";
    await this.items.close("KIOSK", { id: deviceId, part: "pending" }, { state: "DONE", outcome, actorId });
    if (status === "REVOKED") {
      await this.closeVanished(deviceId);
    }
  }

  @OnEvent(KIOSK_EVENT.event)
  async onReport(message: KioskMessage<DeviceEvent>): Promise<void> {
    const reported = message.payload.type;
    const burst = BURSTS[reported];
    const part = FAULTS[reported] ? kebab(reported) : UPDATE_FAILED.has(reported) ? "update" : (burst?.part ?? null);
    if (part === null) {
      return;
    }
    const device = await this.db.device.findUnique({ where: { id: message.deviceId }, select: { status: true } });
    if (device?.status !== "APPROVED") {
      return;
    }
    if (burst) {
      await this.countBurst(message, burst);
      return;
    }
    const errorCode = message.payload.errorCode;
    await this.items.open(
      "KIOSK",
      { id: message.deviceId, part, employeeId: null },
      { level: part === "update" ? "WARNING" : "CRITICAL", facts: { code: reported, ...(errorCode === undefined ? {} : { errorCode }) } },
    );
  }

  // Counted on the kiosk's own clock, the earlier ones only, so this event counts once whether or not its row has landed.
  private async countBurst(message: KioskMessage<DeviceEvent>, burst: NonNullable<(typeof BURSTS)[Reported]>): Promise<void> {
    const ref = { id: message.deviceId, part: burst.part };
    const held = await this.db.noticeItem.findUnique({ where: { key: itemKey("KIOSK", ref) }, select: { state: true } });
    if (held?.state === "OPEN") {
      return;
    }
    const at = new Date(message.payload.ts);
    const window = this.config.get("KIOSK_BURST_WINDOW_MINUTES", { infer: true }) * kMinuteMs;
    const earlier = await this.db.deviceEvent.count({
      where: { deviceId: message.deviceId, type: message.payload.type, ts: { gte: new Date(at.getTime() - window), lt: at } },
    });
    if (earlier + 1 >= this.config.get(burst.limit, { infer: true })) {
      await this.items.open("KIOSK", { ...ref, employeeId: null }, { level: "WARNING", facts: { code: burst.code } });
    }
  }

  // A replayed copy is the broker's memory, not the kiosk speaking now (KEHOACH 7.5).
  @OnEvent(KIOSK_EVENT.status)
  async onStatus(message: KioskMessage<string>): Promise<void> {
    if (message.payload === "online" && !message.retained) {
      await this.items.close("KIOSK", { id: message.deviceId, part: "offline" }, { state: "CLEARED" });
    }
  }

  // A later update that went in shows the kiosk takes updates again (KEHOACH 9.21.4).
  @OnEvent(UPDATE_FINISHED)
  async onUpdated(done: UpdateFinished): Promise<void> {
    await this.items.close("KIOSK", { id: done.deviceId, part: "update" }, { state: "CLEARED" });
  }

  /** Close kiosk work whose reason is gone: a decided request to join, a kiosk heard again, a kiosk out of the fleet,
   *  a burst followed by a quiet hour, a fault or a failed update the kiosk shows mended (KEHOACH 9.21.4).
   *  @ctx any | the sweep, the hourly reconcile and a revoke call it; one UPDATE, then the rows read
   */
  async closeVanished(deviceId: string | null = null, now: Date = new Date()): Promise<number> {
    const quietSince = new Date(now.getTime() - KIOSK_BURST_QUIET_MINUTES * kMinuteMs);
    const settledBy = new Date(now.getTime() - KIOSK_BOOT_SETTLE_MINUTES * kMinuteMs);
    const faults = Object.entries(FAULTS) as [Reported, Proof][];
    // Receipt times order the evidence; a punch proves the camera only when taken after the fault on the kiosk too.
    const shut = await this.db.$queryRaw<{ id: string }[]>`
      UPDATE "NoticeItem" i
         SET "state" = x."state"::"NoticeItemState", "outcome" = x."outcome"::"NoticeOutcome", "closedAt" = now()::timestamp(3)
        FROM (
          SELECT n."id",
                 CASE WHEN d."id" IS NULL THEN 'EXPIRED' WHEN n."key" = p."key" THEN 'DONE' ELSE 'CLEARED' END AS "state",
                 CASE WHEN n."key" = p."key" AND d."status" = 'APPROVED' THEN 'APPROVED'
                      WHEN n."key" = p."key" AND d."status" = 'REVOKED' THEN 'REJECTED' END AS "outcome"
            FROM "NoticeItem" n
            LEFT JOIN "Device" d ON d."id" = n."subjectId"
           CROSS JOIN LATERAL (SELECT 'kiosk:' || n."subjectId" || ':pending' AS "key", 'kiosk:' || n."subjectId" || ':offline' AS "silent") p
           CROSS JOIN LATERAL (
             SELECT CASE n."key" WHEN 'kiosk:' || n."subjectId" || ':spoof' THEN 'SPOOF_DETECTED'
                                 WHEN 'kiosk:' || n."subjectId" || ':unknown' THEN 'UNKNOWN_FACE' END AS "type"
           ) b
            LEFT JOIN unnest(${faults.map(([code]) => kebab(code))}::text[], ${faults.map(([code]) => code)}::text[],
                             ${faults.map(([, proof]) => proof)}::text[]) AS f("part", "code", "proof")
                   ON n."key" = 'kiosk:' || n."subjectId" || ':' || f."part"
           CROSS JOIN LATERAL (
             SELECT GREATEST(n."openedAt", max(v."receivedAt")) AS "since", max(v."ts") AS "said"
               FROM "DeviceEvent" v
              WHERE v."deviceId" = n."subjectId" AND v."type" = f."code"
           ) r
           WHERE n."queue" = 'KIOSK' AND n."state" = 'OPEN'
             AND (${deviceId}::text IS NULL OR n."subjectId" = ${deviceId}::text)
             AND (d."id" IS NULL
                  OR (n."key" = p."key" AND d."status" <> 'PENDING')
                  OR (n."key" <> p."key" AND (d."status" <> 'APPROVED' OR (n."key" = p."silent" AND d."online")))
                  OR (b."type" IS NOT NULL AND NOT EXISTS (
                        SELECT 1 FROM "DeviceEvent" v WHERE v."deviceId" = n."subjectId" AND v."type" = b."type" AND v."ts" >= ${quietSince}))
                  OR (f."proof" = 'boot' AND EXISTS (
                        SELECT 1 FROM "DeviceEvent" v
                         WHERE v."deviceId" = n."subjectId" AND v."type" = 'BOOTED'
                           AND v."receivedAt" > r."since" AND v."receivedAt" <= ${settledBy}))
                  OR (f."proof" = 'face' AND EXISTS (
                        SELECT 1 FROM "DeviceEvent" v
                         WHERE v."deviceId" = n."subjectId" AND v."type" = ANY(${[...FACE_RESULTS]}::text[]) AND v."receivedAt" > r."since"))
                  OR (f."proof" IN ('face', 'punch') AND EXISTS (
                        SELECT 1 FROM "AttendanceRecord" a
                         WHERE a."deviceId" = n."subjectId" AND COALESCE(a."receivedAt", a."createdAt") > r."since"
                           AND (f."proof" = 'punch' OR a."ts" > COALESCE(r."said", '-infinity'::timestamp))))
                  OR (f."proof" = 'quiet' AND d."online" AND d."bootedAt" <= ${quietSince} AND r."since" <= ${quietSince}))
        ) x
       WHERE i."id" = x."id" AND i."state" = 'OPEN'
      RETURNING i."id"
    `;
    await this.items.settle(shut.map((one) => one.id));
    return shut.length + (await this.closeCaughtUp(deviceId));
  }

  // A failed update is moot once the kiosk runs the newest release of every kind (KEHOACH 9.21.4).
  private async closeCaughtUp(deviceId: string | null): Promise<number> {
    const open = await this.db.noticeItem.findMany({
      where: { queue: "KIOSK", state: "OPEN", ...(deviceId === null ? {} : { subjectId: deviceId }) },
      select: { key: true, subjectId: true },
    });
    const failed = open.filter((one) => one.key === itemKey("KIOSK", { id: one.subjectId, part: "update" }));
    if (failed.length === 0) {
      return 0;
    }
    const [devices, newest] = await Promise.all([
      this.db.device.findMany({
        where: { id: { in: failed.map((one) => one.subjectId) } },
        select: { id: true, fwVersion: true, modelVersion: true },
      }),
      this.releases.newest(),
    ]);
    let closed = 0;
    for (const device of devices.filter((one) => ![...newest.values()].some((release) => behind(one, release)))) {
      if (await this.items.close("KIOSK", { id: device.id, part: "update" }, { state: "CLEARED" })) {
        closed += 1;
      }
    }
    return closed;
  }

  // Owed while the silence's work is open and no ADMIN address took it; lastMark 1 on that work says one did.
  private async mailSilent(device: Silent, minutes: number): Promise<void> {
    const work = await this.db.noticeItem.findUnique({
      where: { key: itemKey("KIOSK", { id: device.id, part: "offline" }) },
      select: { id: true, state: true, lastMark: true },
    });
    if (work?.state !== "OPEN" || work.lastMark !== null) {
      return;
    }
    const zone = this.config.get("APP_TIMEZONE", { infer: true });
    const root = this.config.get("APP_PUBLIC_URL", { infer: true });
    const body = kioskSilentMail(DEFAULT_MAIL_LOCALE, {
      deviceId: device.id,
      name: device.name,
      location: device.location,
      minutes,
      lastSeen: device.lastSeenAt ? localStamp(device.lastSeenAt, zone) : "—",
      url: `${root}/${DEFAULT_MAIL_LOCALE}/devices/${device.id}`,
    });
    const admins = await this.db.user.findMany({ where: { role: "ADMIN", active: true }, select: { email: true } });
    let reached = 0;
    for (const admin of admins) {
      try {
        await this.mailer.send(admin.email, body);
        reached += 1;
      } catch (error) {
        this.log.error(`kiosk ${device.id} silent: ${admin.email} refused: ${(error as Error).message}`);
      }
    }
    if (admins.length > 0 && reached === 0) {
      return;
    }
    await this.db.noticeItem.updateMany({ where: { id: work.id, lastMark: null }, data: { lastMark: 1 } });
  }
}
