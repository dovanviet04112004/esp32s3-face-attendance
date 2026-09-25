import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createReadStream, createWriteStream, type ReadStream } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { Readable } from "node:stream";
import { finished } from "node:stream/promises";

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Device, Release } from "@prisma/client";

import type { OtaManifest } from "../../common/generated/ota_manifest.js";
import type { Env } from "../../config/env.schema.js";
import { PrismaService } from "../../database/prisma.service.js";
import { AUDIT_ACTIONS, AUDIT_SUBJECTS } from "../audit/audit-actions.js";
import { AuditService } from "../audit/audit.service.js";
import { MqttService } from "../mqtt/mqtt.service.js";
import { FEED, RealtimeGateway } from "../realtime/realtime.gateway.js";

/** What a publisher may put on the register; ASSETS waits for the kiosk to install it (KEHOACH 7.7). */
export const PUBLISHED_TARGETS = ["FIRMWARE", "MODELS"] as const;
export type PublishedTarget = (typeof PUBLISHED_TARGETS)[number];

/** A release as the dashboard sees it: no file path, and whether it can still be offered. */
export type ReleaseView = Omit<Release, "path" | "url"> & { available: boolean };

export type OfferState = "WAITING" | "INSTALLED" | "FAILED" | "INTERRUPTED" | "EXPIRED";

export interface OfferStatus {
  releaseId: string;
  target: string;
  version: string;
  offeredAt: Date;
  state: OfferState;
  reason: string | null;
  /** Until when the kiosk counts as installing this offer; another offer to it is refused until then. */
  busyUntil: Date | null;
}

/** The newest release of one kind that can still be offered, and the approved kiosks behind it. */
export interface FleetUpdate {
  release: ReleaseView;
  behind: string[];
  /** Behind too, but still installing an earlier offer, so left out of an offer to all. */
  updating: string[];
}

export interface PublishFacts {
  target: PublishedTarget;
  version: string;
  minFwVersion?: string;
  runId?: string;
}

const VERSION_SHAPE: Record<PublishedTarget, RegExp> = {
  FIRMWARE: /^\d+\.\d+\.\d+$/,
  MODELS: /^img-[0-9a-f]{8}$/,
};

// The ESP-IDF app image: its header magic, then esp_app_desc_t at 0x20 with the version at 0x30.
const APP_IMAGE_MAGIC = 0xe9;
const APP_DESC_OFFSET = 0x20;
const APP_DESC_MAGIC = 0xabcd5432;
const APP_VERSION_OFFSET = 0x30;
const APP_VERSION_BYTES = 32;
const APP_HEAD_BYTES = APP_VERSION_OFFSET + APP_VERSION_BYTES;
const KEEP_FILES = 5;
const UNIQUE_VIOLATION = "P2002";
const OTA_FAILED = "OTA_FAILED";
const LINK_PURPOSE = "release-link";
const kHourMs = 3_600_000;
const kMinuteMs = 60_000;

function semver(version: string | null): [number, number, number] | null {
  const parts = version?.match(/^(\d+)\.(\d+)\.(\d+)$/);
  return parts ? [Number(parts[1]), Number(parts[2]), Number(parts[3])] : null;
}

/** Whether a kiosk runs something older than the release; a version it cannot state counts as older. */
export function behind(device: Pick<Device, "fwVersion" | "modelVersion">, release: Pick<Release, "target" | "version">): boolean {
  if (release.target === "MODELS") {
    return device.modelVersion !== release.version;
  }
  const mine = semver(device.fwVersion);
  const theirs = semver(release.version);
  if (!mine || !theirs) {
    return true;
  }
  for (let part = 0; part < 3; part += 1) {
    if (mine[part] !== theirs[part]) {
      return mine[part] < theirs[part];
    }
  }
  return false;
}

function runs(device: Pick<Device, "fwVersion" | "modelVersion">, release: Pick<Release, "target" | "version">): boolean {
  return (release.target === "MODELS" ? device.modelVersion : device.fwVersion) === release.version;
}

function view(release: Release): ReleaseView {
  const { path, url: _url, ...rest } = release;
  return { ...rest, available: path !== null };
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

@Injectable()
export class ModelsService implements OnModuleInit {
  private readonly log = new Logger(ModelsService.name);
  private readonly dir: string;
  private readonly linkKey: Buffer;
  private readonly busyMs: number;

  constructor(
    private readonly db: PrismaService,
    private readonly mqtt: MqttService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env, true>,
    private readonly feed: RealtimeGateway,
  ) {
    this.dir = resolve(this.config.get("RELEASE_DIR", { infer: true }));
    this.linkKey = createHmac("sha256", this.config.get("JWT_DEVICE_SECRET", { infer: true }))
      .update(LINK_PURPOSE)
      .digest();
    this.busyMs = this.config.get("OTA_BUSY_MINUTES", { infer: true }) * kMinuteMs;
  }

  // A volume that cannot be written only stops publishing, so it is logged rather than fatal.
  async onModuleInit(): Promise<void> {
    await mkdir(this.dir, { recursive: true }).catch((error: Error) =>
      this.log.error(`releases cannot be stored in ${this.dir}: ${error.message}`),
    );
  }

  async list(): Promise<ReleaseView[]> {
    const rows = await this.db.release.findMany({ orderBy: { createdAt: "desc" } });
    return rows.map(view);
  }

  /** What the dashboard offers with one press: one entry per kind, read here so the rule lives once. */
  async fleet(): Promise<FleetUpdate[]> {
    const devices = await this.db.device.findMany({
      where: { status: "APPROVED" },
      select: { id: true, fwVersion: true, modelVersion: true },
      orderBy: { id: "asc" },
    });
    const busy = await this.installing();
    const updates: FleetUpdate[] = [];
    for (const target of PUBLISHED_TARGETS) {
      const newest = await this.db.release.findFirst({
        where: { target, path: { not: null } },
        orderBy: { createdAt: "desc" },
      });
      if (newest) {
        const older = devices.filter((one) => behind(one, newest)).map((one) => one.id);
        updates.push({
          release: view(newest),
          behind: older.filter((id) => !busy.has(id)),
          updating: older.filter((id) => busy.has(id)),
        });
      }
    }
    return updates;
  }

  /** Whether a release is already on the register, so the publisher can skip building it. */
  async published(target: PublishedTarget, version: string): Promise<{ published: boolean }> {
    const held = await this.db.release.findUnique({ where: { target_version: { target, version } }, select: { releaseId: true } });
    return { published: held !== null };
  }

  /**
   * Store a release from the body of the publisher's request. Hashed while it
   * is written, so the digest can only describe the file kept (KEHOACH 7.7).
   */
  async publish(facts: PublishFacts, body: Readable): Promise<{ release: ReleaseView; existing: boolean }> {
    if (!VERSION_SHAPE[facts.target].test(facts.version)) {
      await this.drain(body);
      throw new BadRequestException("RELEASE_VERSION_INVALID");
    }
    const held = await this.db.release.findUnique({
      where: { target_version: { target: facts.target, version: facts.version } },
    });
    if (held) {
      await this.drain(body);
      return { release: view(held), existing: true };
    }
    const releaseId = randomUUID();
    const file = `${releaseId}.bin`;
    const { sha256, sizeBytes, head } = await this.store(body, `${this.dir}/${file}.part`);
    let release: Release;
    // Only a failure ahead of the row removes the file; once the row names it, the file stays.
    try {
      if (facts.target === "FIRMWARE") {
        this.checkAppImage(head, facts.version);
      }
      await rename(`${this.dir}/${file}.part`, `${this.dir}/${file}`);
      release = await this.db.release.create({
        data: {
          releaseId,
          target: facts.target,
          version: facts.version,
          path: file,
          sha256,
          sizeBytes,
          minFwVersion: facts.minFwVersion ?? null,
          runId: facts.runId ?? null,
        },
      });
    } catch (error) {
      await rm(`${this.dir}/${file}.part`, { force: true });
      await rm(`${this.dir}/${file}`, { force: true });
      if (isCode(error, UNIQUE_VIOLATION)) {
        const raced = await this.db.release.findUniqueOrThrow({
          where: { target_version: { target: facts.target, version: facts.version } },
        });
        return { release: view(raced), existing: true };
      }
      throw error;
    }
    await this.audit.record({
      action: AUDIT_ACTIONS.RELEASE_PUBLISH,
      subject: AUDIT_SUBJECTS.RELEASE,
      subjectId: releaseId,
      meta: { target: facts.target, version: facts.version, sha256, sizeBytes },
    });
    this.log.log(`published ${facts.target} ${facts.version}, ${sizeBytes} bytes, ${sha256}`);
    await this.prune(facts.target).catch((error: Error) =>
      this.log.error(`older ${facts.target} files not pruned: ${error.message}`),
    );
    // The publisher is a token, not a person, so the change interceptor never announces it.
    this.feed.publish(FEED.change, { resources: ["releases"] }, null);
    return { release: view(release), existing: false };
  }

  /** The file a signed link names, for a kiosk still in the fleet (KEHOACH 7.7). */
  async image(releaseId: string, deviceId: string, expiresS: number, sig: string): Promise<{ stream: ReadStream; sizeBytes: number }> {
    const want = Buffer.from(this.signature(releaseId, deviceId, expiresS), "hex");
    const given = Buffer.from(/^[0-9a-f]{64}$/.test(sig) ? sig : "", "hex");
    if (given.length !== want.length || !timingSafeEqual(given, want) || expiresS * 1000 < Date.now()) {
      throw new ForbiddenException("RELEASE_LINK_REJECTED");
    }
    const device = await this.db.device.findUnique({ where: { id: deviceId }, select: { status: true } });
    if (device?.status !== "APPROVED") {
      throw new ForbiddenException("RELEASE_LINK_REJECTED");
    }
    const release = await this.db.release.findUnique({ where: { releaseId } });
    if (!release?.path) {
      throw new GoneException("RELEASE_GONE");
    }
    return { stream: createReadStream(`${this.dir}/${release.path}`), sizeBytes: release.sizeBytes };
  }

  /**
   * Offer a release to one kiosk. The kiosk re-checks everything on its own,
   * so this is an offer and not an instruction.
   */
  async offer(releaseId: string, deviceId: string, actorId: string): Promise<{ deviceId: string; offeredAt: Date }> {
    const release = await this.offerable(releaseId);
    const device = await this.db.device.findUnique({ where: { id: deviceId } });
    if (!device) {
      throw new NotFoundException("DEVICE_NOT_FOUND");
    }
    if (device.status !== "APPROVED") {
      throw new ConflictException("DEVICE_NOT_APPROVED");
    }
    // The kiosk never compares versions, so offering what it runs would reinstall it.
    if (runs(device, release)) {
      throw new ConflictException("RELEASE_ALREADY_RUNNING");
    }
    // One ota_task per kiosk, and Device keeps only the newest offer (KEHOACH 7.7).
    if ((await this.status(deviceId))?.busyUntil) {
      throw new ConflictException("OTA_IN_PROGRESS");
    }
    return this.send(release, deviceId, actorId);
  }

  /** Offer a release to every approved kiosk running something older and not installing already. */
  async offerAll(releaseId: string, actorId: string): Promise<{ offered: string[]; failed: string[]; busy: string[] }> {
    const release = await this.offerable(releaseId);
    const installing = await this.installing();
    const fleet = await this.db.device.findMany({
      where: { status: "APPROVED" },
      select: { id: true, fwVersion: true, modelVersion: true },
      orderBy: { id: "asc" },
    });
    const offered: string[] = [];
    const failed: string[] = [];
    const busy: string[] = [];
    for (const device of fleet.filter((one) => behind(one, release))) {
      if (installing.has(device.id)) {
        busy.push(device.id);
        continue;
      }
      try {
        await this.send(release, device.id, actorId);
        offered.push(device.id);
      } catch (error) {
        this.log.error(`could not offer ${release.version} to ${device.id}: ${(error as Error).message}`);
        failed.push(device.id);
      }
    }
    return { offered, failed, busy };
  }

  /** How the newest offer to a kiosk went, read from its heartbeat and its events. */
  async status(deviceId: string): Promise<OfferStatus | null> {
    const device = await this.db.device.findUnique({ where: { id: deviceId } });
    if (!device) {
      throw new NotFoundException("DEVICE_NOT_FOUND");
    }
    if (!device.otaReleaseId || !device.otaOfferedAt) {
      return null;
    }
    const release = await this.db.release.findUnique({ where: { releaseId: device.otaReleaseId } });
    if (!release) {
      return null;
    }
    const failure = runs(device, release)
      ? null
      : await this.db.deviceEvent.findFirst({
          where: { deviceId, type: OTA_FAILED, ts: { gte: device.otaOfferedAt } },
          orderBy: { ts: "desc" },
          select: { message: true },
        });
    return this.offerState({ ...device, otaOfferedAt: device.otaOfferedAt }, release, failure);
  }

  private offerState(
    device: Pick<Device, "fwVersion" | "modelVersion" | "bootedAt"> & { otaOfferedAt: Date },
    release: Release,
    failure: { message: string | null } | null,
  ): OfferStatus {
    const base = {
      releaseId: release.releaseId,
      target: release.target,
      version: release.version,
      offeredAt: device.otaOfferedAt,
      busyUntil: null,
    };
    if (runs(device, release)) {
      return { ...base, state: "INSTALLED", reason: null };
    }
    if (failure) {
      return { ...base, state: "FAILED", reason: failure.message };
    }
    // A boot after the offer on the old release is a cut download or a rolled-back trial.
    if (device.bootedAt && device.bootedAt > device.otaOfferedAt) {
      return { ...base, state: "INTERRUPTED", reason: null };
    }
    const linkMs = this.config.get("RELEASE_LINK_HOURS", { infer: true }) * kHourMs;
    if (Date.now() - device.otaOfferedAt.getTime() > linkMs) {
      return { ...base, state: "EXPIRED", reason: null };
    }
    const busyEnds = device.otaOfferedAt.getTime() + this.busyMs;
    return { ...base, state: "WAITING", reason: null, busyUntil: busyEnds > Date.now() ? new Date(busyEnds) : null };
  }

  // The approved kiosks inside the busy window of an offer they have not answered yet, in three reads.
  private async installing(): Promise<Set<string>> {
    const since = new Date(Date.now() - this.busyMs);
    const recent = await this.db.device.findMany({
      where: { status: "APPROVED", otaOfferedAt: { gt: since }, otaReleaseId: { not: null } },
      select: { id: true, fwVersion: true, modelVersion: true, bootedAt: true, otaReleaseId: true, otaOfferedAt: true },
    });
    if (recent.length === 0) {
      return new Set();
    }
    const [releases, failures] = await Promise.all([
      this.db.release.findMany({
        where: { releaseId: { in: [...new Set(recent.map((one) => one.otaReleaseId as string))] } },
      }),
      this.db.deviceEvent.findMany({
        where: { deviceId: { in: recent.map((one) => one.id) }, type: OTA_FAILED, ts: { gt: since } },
        select: { deviceId: true, ts: true, message: true },
        orderBy: { ts: "desc" },
      }),
    ]);
    const releaseOf = new Map(releases.map((one) => [one.releaseId, one]));
    const busy = new Set<string>();
    for (const one of recent) {
      const release = releaseOf.get(one.otaReleaseId as string);
      const offeredAt = one.otaOfferedAt as Date;
      if (!release) {
        continue;
      }
      const failure = failures.find((event) => event.deviceId === one.id && event.ts >= offeredAt) ?? null;
      if (this.offerState({ ...one, otaOfferedAt: offeredAt }, release, failure).busyUntil) {
        busy.add(one.id);
      }
    }
    return busy;
  }

  private async offerable(releaseId: string): Promise<Release> {
    const release = await this.db.release.findUnique({ where: { releaseId } });
    if (!release) {
      throw new NotFoundException("RELEASE_NOT_FOUND");
    }
    if (!release.path) {
      throw new GoneException("RELEASE_GONE");
    }
    return release;
  }

  private async send(release: Release, deviceId: string, actorId: string): Promise<{ deviceId: string; offeredAt: Date }> {
    const manifest: OtaManifest = {
      releaseId: release.releaseId,
      target: release.target as OtaManifest["target"],
      version: release.version,
      url: this.link(release.releaseId, deviceId),
      sha256: release.sha256,
      sizeBytes: release.sizeBytes,
      ...(release.minFwVersion ? { minFwVersion: release.minFwVersion } : {}),
      ...(release.runId ? { runId: release.runId } : {}),
    };
    await this.mqtt.publishDown("ota", deviceId, manifest);
    const offeredAt = new Date();
    await this.db.device.update({
      where: { id: deviceId },
      data: { otaReleaseId: release.releaseId, otaOfferedAt: offeredAt },
    });
    await this.db.release.update({ where: { releaseId: release.releaseId }, data: { rolloutState: "ROLLING" } });
    await this.audit.record({
      actorId,
      action: AUDIT_ACTIONS.RELEASE_OFFER,
      subject: AUDIT_SUBJECTS.DEVICE,
      subjectId: deviceId,
      meta: { releaseId: release.releaseId, target: release.target, version: release.version },
    });
    this.log.log(`offered ${release.target} ${release.version} to ${deviceId}`);
    return { deviceId, offeredAt };
  }

  private link(releaseId: string, deviceId: string): string {
    const expiresS = Math.floor((Date.now() + this.config.get("RELEASE_LINK_HOURS", { infer: true }) * kHourMs) / 1000);
    const query = new URLSearchParams({
      device: deviceId,
      exp: String(expiresS),
      sig: this.signature(releaseId, deviceId, expiresS),
    });
    return `${this.config.get("API_PUBLIC_URL", { infer: true })}/releases/${releaseId}/image?${query.toString()}`;
  }

  private signature(releaseId: string, deviceId: string, expiresS: number): string {
    return createHmac("sha256", this.linkKey).update(`${releaseId}.${deviceId}.${expiresS}`).digest("hex");
  }

  private async store(body: Readable, part: string): Promise<{ sha256: string; sizeBytes: number; head: Buffer }> {
    const ceiling = this.config.get("OTA_MAX_BYTES", { infer: true });
    const digest = createHash("sha256");
    const out = createWriteStream(part, { flags: "w" });
    const head: Buffer[] = [];
    let sizeBytes = 0;
    try {
      // Read past the ceiling rather than throw mid-body, which cuts the socket ahead of the answer.
      for await (const chunk of body as AsyncIterable<Buffer>) {
        sizeBytes += chunk.byteLength;
        if (sizeBytes > ceiling * 2) {
          break;
        }
        if (sizeBytes > ceiling) {
          continue;
        }
        if (sizeBytes - chunk.byteLength < APP_HEAD_BYTES) {
          head.push(chunk);
        }
        digest.update(chunk);
        if (!out.write(chunk)) {
          await new Promise((drained) => out.once("drain", drained));
        }
      }
      out.end();
      await finished(out);
    } catch (error) {
      out.destroy();
      await rm(part, { force: true });
      throw error;
    }
    if (sizeBytes > ceiling) {
      await rm(part, { force: true });
      throw new BadRequestException("RELEASE_TOO_BIG");
    }
    if (sizeBytes === 0) {
      await rm(part, { force: true });
      throw new BadRequestException("RELEASE_EMPTY");
    }
    return { sha256: digest.digest("hex"), sizeBytes, head: Buffer.concat(head).subarray(0, APP_HEAD_BYTES) };
  }

  private checkAppImage(head: Buffer, version: string): void {
    if (head.length < APP_HEAD_BYTES || head[0] !== APP_IMAGE_MAGIC || head.readUInt32LE(APP_DESC_OFFSET) !== APP_DESC_MAGIC) {
      throw new BadRequestException("RELEASE_NOT_APP_IMAGE");
    }
    const inside = head.subarray(APP_VERSION_OFFSET, APP_VERSION_OFFSET + APP_VERSION_BYTES);
    const stated = inside.subarray(0, inside.indexOf(0) === -1 ? APP_VERSION_BYTES : inside.indexOf(0)).toString("utf8");
    if (stated !== version) {
      throw new BadRequestException("RELEASE_VERSION_MISMATCH");
    }
  }

  private async drain(body: Readable): Promise<void> {
    body.resume();
    await finished(body).catch(() => undefined);
  }

  private async prune(target: string): Promise<void> {
    const older = await this.db.release.findMany({
      where: { target, path: { not: null } },
      orderBy: { createdAt: "desc" },
      skip: KEEP_FILES,
    });
    for (const release of older) {
      await rm(`${this.dir}/${release.path}`, { force: true });
      await this.db.release.update({ where: { releaseId: release.releaseId }, data: { path: null } });
      this.log.log(`pruned the file of ${release.target} ${release.version}`);
    }
  }
}
