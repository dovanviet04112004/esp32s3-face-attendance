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
import { EventEmitter2, OnEvent } from "@nestjs/event-emitter";
import type { Device, DeviceEvent, Release } from "@prisma/client";

import type { OtaManifest } from "../../common/generated/ota_manifest.js";
import type { Env } from "../../config/env.schema.js";
import { isPrismaCode, PrismaService, UNIQUE_VIOLATION } from "../../database/prisma.service.js";
import { AUDIT_ACTIONS, AUDIT_SUBJECTS } from "../audit/audit-actions.js";
import { AuditService } from "../audit/audit.service.js";
import { DEVICE_BEAT, type DeviceBeat } from "../devices/devices.service.js";
import { MqttService } from "../mqtt/mqtt.service.js";
import { FEED, RealtimeGateway } from "../realtime/realtime.gateway.js";
import {
  behind,
  changesRecognition,
  PUBLISHED_TARGETS,
  RELEASE_PUBLISHED,
  semver,
  UPDATE_FINISHED,
  type PublishedTarget,
  type ReleasePublished,
  type UpdateFinished,
} from "./release-rules.js";

/** A release as the dashboard sees it: no file path, and whether it can still be offered. */
export type ReleaseView = Omit<Release, "path" | "summary" | "notes"> & { available: boolean };

/** What the publisher says about a release: notes per language, and for firmware the models it needs (KEHOACH 7.7). */
export interface ReleaseDetails {
  target: PublishedTarget;
  version: string;
  notesVi: string;
  notesEn: string;
  requiresModels?: string | null;
}

/** One release named by kind and version, as an update step. */
export interface ReleaseStep {
  target: string;
  version: string;
}

export type OfferState = "WAITING" | "INSTALLED" | "TRIAL" | "ROLLED_BACK" | "FAILED" | "INTERRUPTED" | "EXPIRED";

export interface OfferStatus {
  releaseId: string;
  target: string;
  version: string;
  offeredAt: Date;
  state: OfferState;
  reason: string | null;
  /** Until when the kiosk counts as installing this offer; another offer to it is refused until then. */
  busyUntil: Date | null;
  /** The step the server offers once this one is installed, from one Update press (KEHOACH 7.7). */
  next: ReleaseStep | null;
}

/** The newest release of one kind that can still be offered, and the approved kiosks behind it. */
export interface FleetUpdate {
  release: ReleaseView;
  behind: string[];
  /** Behind too, but still installing an earlier offer, so left out of an offer to all. */
  updating: string[];
  /** Behind too, but offline: an offer is not kept for it, so it is left out of an offer to all (KEHOACH 7.7). */
  offline: string[];
  /** Installing it drops every template on the kiosks behind, so it goes to all of them, confirmed (KEHOACH 7.5). */
  changesRecognition: boolean;
  /** The kiosks, behind or updating, this release moves to another recognition model; none of them takes it alone. */
  recapture: string[];
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
// storage_models_header_t and storage_model_entry_t of sys_storage/include/storage_format.h (KEHOACH 6.2.2).
const MODELS_MAGIC = 0x534c444d;
const MODELS_COUNT_OFFSET = 8;
const MODELS_ENTRY_OFFSET = 0x10;
const MODELS_ENTRY_BYTES = 64;
const MODELS_ENTRY_CAP = 3;
const MODELS_NAME_BYTES = 16;
const MODELS_SHA_OFFSET = 24;
const MODELS_HEAD_BYTES = 256;
const RECOGNITION_ENTRY = "recog";
// embedding_version() in firmware/main/app_tasks.c names a model by these many sha256 bytes.
const EMBEDDING_SHA_BYTES = 8;
const HEAD_BYTES = Math.max(APP_HEAD_BYTES, MODELS_HEAD_BYTES);
const KEEP_FILES = 5;
const OTA_FAILED = "OTA_FAILED";
const OTA_ROLLED_BACK = "OTA_ROLLED_BACK";
const OTA_REPORTS = [OTA_ROLLED_BACK, OTA_FAILED];
const LINK_PURPOSE = "release-link";
const kHourMs = 3_600_000;
const kMinuteMs = 60_000;

function runs(device: Pick<Device, "fwVersion" | "modelVersion">, release: Pick<Release, "target" | "version">): boolean {
  return (release.target === "MODELS" ? device.modelVersion : device.fwVersion) === release.version;
}

type OtaReport = Pick<DeviceEvent, "type" | "cmdId" | "message" | "receivedAt">;

/** The kiosk's newest report of one kind on an offer: heard after it, naming it, or from a build that names none. */
function reportOn(reports: OtaReport[], type: string, releaseId: string, offeredAt: Date): OtaReport | null {
  const heard = reports
    .filter((one) => one.type === type && one.receivedAt >= offeredAt && (one.cmdId === null || one.cmdId === releaseId))
    .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
  return heard.find((one) => one.cmdId === releaseId) ?? heard[0] ?? null;
}

/** The recognition model a models image carries, named the way the kiosk's heartbeat names it. */
function embeddingOf(head: Buffer): string | null {
  if (head.length < MODELS_HEAD_BYTES || head.readUInt32LE(0) !== MODELS_MAGIC) {
    return null;
  }
  const count = Math.min(head.readUInt32LE(MODELS_COUNT_OFFSET), MODELS_ENTRY_CAP);
  for (let at = 0; at < count; at += 1) {
    const entry = head.subarray(MODELS_ENTRY_OFFSET + at * MODELS_ENTRY_BYTES, MODELS_ENTRY_OFFSET + (at + 1) * MODELS_ENTRY_BYTES);
    const raw = entry.subarray(0, MODELS_NAME_BYTES);
    const name = raw.subarray(0, raw.indexOf(0) === -1 ? MODELS_NAME_BYTES : raw.indexOf(0)).toString("utf8");
    if (name === RECOGNITION_ENTRY) {
      return `recog-${entry.subarray(MODELS_SHA_OFFSET, MODELS_SHA_OFFSET + EMBEDDING_SHA_BYTES).toString("hex")}`;
    }
  }
  return null;
}

function view(release: Release): ReleaseView {
  const { path, summary, notes, ...rest } = release;
  return { ...rest, available: path !== null };
}

function stepOf(release: Release): ReleaseStep {
  return { target: release.target, version: release.version };
}

// MAJOR.MINOR.PATCH order; a version that cannot be read meets no minimum.
function atLeast(version: string | null, wanted: string): boolean {
  const mine = semver(version);
  const theirs = semver(wanted);
  if (!mine || !theirs) {
    return false;
  }
  for (let part = 0; part < 3; part += 1) {
    if (mine[part] !== theirs[part]) {
      return mine[part] > theirs[part];
    }
  }
  return true;
}

type Runs = Pick<Device, "fwVersion" | "modelVersion">;

// KEHOACH 7.7: the shortest order of releases with a file, published by asOf, from what the kiosk runs to the newest
// of both kinds, every claim met as its step installs; firmware opens a path when two are as short. Null: it runs both.
function route(device: Runs & Pick<Device, "fwOnTrial">, releases: Release[], asOf: Date | null): Release[] | null {
  const steps = releases.filter((one) => one.path !== null && (asOf === null || one.createdAt <= asOf));
  const firmware = steps.filter((one) => one.target === "FIRMWARE");
  const models = steps.filter((one) => one.target === "MODELS");
  const goals = [firmware[0], models[0]].filter((one): one is Release => one !== undefined);
  // Models order by when they reached the server; img- names do not sort.
  const modelsAt = new Map(releases.filter((one) => one.target === "MODELS").map((one) => [one.version, one.createdAt.getTime()]));
  const timeOf = (version: string | null) => (version === null ? undefined : modelsAt.get(version));
  const done = (runs: Runs) => goals.every((goal) => !behind(runs, goal));
  const moves = (runs: Runs): Release[] => [
    ...firmware.filter((one) => {
      const ran = timeOf(runs.modelVersion);
      const wanted = one.requiresModels === null ? undefined : timeOf(one.requiresModels);
      return behind(runs, one) && (one.requiresModels === null || (ran !== undefined && wanted !== undefined && ran >= wanted));
    }),
    ...models.filter((one) => {
      const ran = timeOf(runs.modelVersion);
      return (
        one.version !== runs.modelVersion &&
        (ran === undefined || one.createdAt.getTime() > ran) &&
        (one.minFwVersion === null || atLeast(runs.fwVersion, one.minFwVersion))
      );
    }),
  ];
  const start: Runs = { fwVersion: device.fwVersion, modelVersion: device.modelVersion };
  if (done(start)) {
    return null;
  }
  // The kiosk takes no offer while a firmware is on trial (FIRMWARE_ON_TRIAL, ESP_OTA_IMG_PENDING_VERIFY).
  if (device.fwOnTrial === true) {
    throw new ConflictException("OTA_IN_PROGRESS");
  }
  const keyOf = (runs: Runs) => `${runs.fwVersion ?? ""}|${runs.modelVersion ?? ""}`;
  const seen = new Set([keyOf(start)]);
  let level: { runs: Runs; path: Release[] }[] = [{ runs: start, path: [] }];
  while (level.length > 0) {
    const deeper: typeof level = [];
    for (const { runs, path } of level) {
      for (const step of moves(runs)) {
        const after = step.target === "FIRMWARE" ? { ...runs, fwVersion: step.version } : { ...runs, modelVersion: step.version };
        const longer = [...path, step];
        if (done(after)) {
          return longer;
        }
        if (!seen.has(keyOf(after))) {
          seen.add(keyOf(after));
          deeper.push({ runs: after, path: longer });
        }
      }
    }
    level = deeper;
  }
  throw new ConflictException("RELEASE_UNREACHABLE");
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
    private readonly bus: EventEmitter2,
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
      select: { id: true, fwVersion: true, modelVersion: true, embeddingVersion: true, online: true },
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
        const older = devices.filter((one) => behind(one, newest));
        const idle = older.filter((one) => !busy.has(one.id));
        const reachable = idle.filter((one) => one.online);
        updates.push({
          release: view(newest),
          behind: reachable.map((one) => one.id),
          updating: older.filter((one) => busy.has(one.id)).map((one) => one.id),
          offline: idle.filter((one) => !one.online).map((one) => one.id),
          changesRecognition: reachable.some((one) => changesRecognition(one, newest)),
          recapture: older.filter((one) => changesRecognition(one, newest)).map((one) => one.id),
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

  /** Write the notes of a release on the register and, for firmware, the models it needs (KEHOACH 7.7). */
  async describe(details: ReleaseDetails): Promise<ReleaseView> {
    const { target, version, notesVi, notesEn } = details;
    const requiresModels = details.requiresModels ?? null;
    const held = await this.db.release.findUnique({ where: { target_version: { target, version } } });
    if (!held) {
      throw new NotFoundException("RELEASE_NOT_FOUND");
    }
    if (requiresModels !== null) {
      if (target !== "FIRMWARE") {
        throw new BadRequestException("RELEASE_REQUIRES_INVALID");
      }
      const needed = await this.db.release.findUnique({
        where: { target_version: { target: "MODELS", version: requiresModels } },
      });
      if (!needed) {
        throw new BadRequestException("RELEASE_REQUIRES_INVALID");
      }
      // Each needs the other first, so no order of two steps installs the pair.
      if (needed.minFwVersion && atLeast(needed.minFwVersion, version)) {
        throw new ConflictException("RELEASE_LOCKSTEP");
      }
    }
    const release = await this.db.release.update({
      where: { releaseId: held.releaseId },
      data: { notesVi, notesEn, requiresModels },
    });
    await this.audit.record({
      action: AUDIT_ACTIONS.RELEASE_NOTES,
      subject: AUDIT_SUBJECTS.RELEASE,
      subjectId: release.releaseId,
      meta: { target, version, requiresModels },
    });
    this.feed.publish(FEED.change, { resources: ["releases"] }, null);
    return view(release);
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
    // Without it no update order can be worked out for a kiosk behind on both (KEHOACH 7.7).
    if (facts.target === "MODELS" && !facts.minFwVersion) {
      await this.drain(body);
      throw new BadRequestException("RELEASE_MIN_FW_REQUIRED");
    }
    // Refused here, so an Update press never meets models no published firmware can run.
    if (facts.target === "MODELS" && !(await this.firmwareRuns(facts.minFwVersion as string))) {
      await this.drain(body);
      throw new ConflictException("RELEASE_FIRMWARE_MISSING");
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
    const embeddingVersion = facts.target === "MODELS" ? embeddingOf(head) : null;
    // Only a failure ahead of the row removes the file; once the row names it, the file stays.
    try {
      if (facts.target === "FIRMWARE") {
        this.checkAppImage(head, facts.version);
      }
      if (facts.target === "MODELS" && embeddingVersion === null) {
        throw new BadRequestException("RELEASE_NOT_MODELS_IMAGE");
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
          embeddingVersion,
        },
      });
    } catch (error) {
      await rm(`${this.dir}/${file}.part`, { force: true });
      await rm(`${this.dir}/${file}`, { force: true });
      if (isPrismaCode(error, UNIQUE_VIOLATION)) {
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
      meta: { target: facts.target, version: facts.version, sha256, sizeBytes, embeddingVersion },
    });
    this.log.log(`published ${facts.target} ${facts.version}, ${sizeBytes} bytes, ${sha256}`);
    await this.prune(facts.target).catch((error: Error) =>
      this.log.error(`older ${facts.target} files not pruned: ${error.message}`),
    );
    // The publisher is a token, not a person, so the change interceptor never announces it.
    this.feed.publish(FEED.change, { resources: ["releases"] }, null);
    this.bus.emit(RELEASE_PUBLISHED, { releaseId } satisfies ReleasePublished);
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
    // One door on another model would refuse every face captured at the rest (KEHOACH 7.5).
    if (changesRecognition(device, release)) {
      throw new ConflictException("RELEASE_CHANGES_RECOGNITION");
    }
    // One ota_task per kiosk, and Device keeps only the newest offer (KEHOACH 7.7).
    if ((await this.status(deviceId))?.busyUntil) {
      throw new ConflictException("OTA_IN_PROGRESS");
    }
    // The offer goes QoS 1, unretained, to a clean session: an offline kiosk never hears it (KEHOACH 7.7).
    if (!device.online) {
      throw new ConflictException("DEVICE_OFFLINE");
    }
    const offeredAt = await this.send(release, device, actorId, { next: null, pressedAt: new Date() });
    if (!offeredAt) {
      throw new ConflictException((await this.isOnline(deviceId)) ? "OTA_IN_PROGRESS" : "DEVICE_OFFLINE");
    }
    return { deviceId, offeredAt };
  }

  /** Offer a release to every approved, online kiosk running something older and not installing already.
   *  One that changes recognition needs `recapture`, the admin's word that everyone is captured again.
   */
  async offerAll(
    releaseId: string,
    actorId: string,
    recapture = false,
  ): Promise<{ offered: string[]; failed: string[]; busy: string[]; offline: string[] }> {
    const pressedAt = new Date();
    const release = await this.offerable(releaseId);
    const installing = await this.installing();
    const fleet = await this.db.device.findMany({
      where: { status: "APPROVED" },
      select: {
        id: true,
        fwVersion: true,
        modelVersion: true,
        embeddingVersion: true,
        otaReleaseId: true,
        otaOfferedAt: true,
        otaNextReleaseId: true,
        otaPressedAt: true,
        otaPressedById: true,
        online: true,
      },
      orderBy: { id: "asc" },
    });
    const older = fleet.filter((one) => behind(one, release));
    if (!recapture && older.some((one) => !installing.has(one.id) && one.online && changesRecognition(one, release))) {
      throw new ConflictException("RELEASE_CHANGES_RECOGNITION");
    }
    const offered: string[] = [];
    const failed: string[] = [];
    const busy: string[] = [];
    const offline: string[] = [];
    for (const device of older) {
      if (installing.has(device.id)) {
        busy.push(device.id);
        continue;
      }
      if (!device.online) {
        offline.push(device.id);
        continue;
      }
      try {
        const sent = await this.send(release, device, actorId, { next: null, pressedAt });
        if (sent) {
          offered.push(device.id);
        } else {
          ((await this.isOnline(device.id)) ? busy : offline).push(device.id);
        }
      } catch (error) {
        this.log.error(`could not offer ${release.version} to ${device.id}: ${(error as Error).message}`);
        failed.push(device.id);
      }
    }
    return { offered, failed, busy, offline };
  }

  /** Bring one kiosk to the newest firmware and models in the order their claims allow: the first step is
   *  offered now and each next one once a heartbeat shows the one ahead installed (KEHOACH 7.7).
   */
  async update(deviceId: string, actorId: string): Promise<{ deviceId: string; offered: ReleaseStep; next: ReleaseStep | null }> {
    const device = await this.db.device.findUnique({ where: { id: deviceId } });
    if (!device) {
      throw new NotFoundException("DEVICE_NOT_FOUND");
    }
    if (device.status !== "APPROVED") {
      throw new ConflictException("DEVICE_NOT_APPROVED");
    }
    const pressedAt = new Date();
    const path = route(device, await this.releases(), null);
    if (!path) {
      throw new ConflictException("RELEASE_ALREADY_RUNNING");
    }
    // One door on another model would refuse every face captured at the rest (KEHOACH 7.5).
    if (path.some((step) => changesRecognition(device, step))) {
      throw new ConflictException("RELEASE_CHANGES_RECOGNITION");
    }
    if ((await this.status(deviceId))?.busyUntil) {
      throw new ConflictException("OTA_IN_PROGRESS");
    }
    if (!device.online) {
      throw new ConflictException("DEVICE_OFFLINE");
    }
    const [first, next = null] = path;
    const offeredAt = await this.send(first, device, actorId, { next, pressedAt });
    if (!offeredAt) {
      throw new ConflictException((await this.isOnline(deviceId)) ? "OTA_IN_PROGRESS" : "DEVICE_OFFLINE");
    }
    return { deviceId, offered: stepOf(first), next: next ? stepOf(next) : null };
  }

  /** The same for every approved, online kiosk behind on either kind. A release that changes recognition needs
   *  `recapture`; a kiosk with no path to the newest counts as failed, one on firmware trial as busy.
   */
  async updateAll(
    actorId: string,
    recapture = false,
  ): Promise<{ offered: string[]; failed: string[]; busy: string[]; offline: string[] }> {
    const pressedAt = new Date();
    const releases = await this.releases();
    const installing = await this.installing();
    const fleet = await this.db.device.findMany({ where: { status: "APPROVED" }, orderBy: { id: "asc" } });
    const failed: string[] = [];
    const busy: string[] = [];
    const planned: { device: Device; path: Release[] }[] = [];
    for (const device of fleet) {
      try {
        const path = route(device, releases, null);
        if (path) {
          planned.push({ device, path });
        }
      } catch (error) {
        (error instanceof ConflictException && error.message === "OTA_IN_PROGRESS" ? busy : failed).push(device.id);
      }
    }
    const moves = (device: Device, path: Release[]) => path.some((step) => changesRecognition(device, step));
    if (!recapture && planned.some(({ device, path }) => !installing.has(device.id) && device.online && moves(device, path))) {
      throw new ConflictException("RELEASE_CHANGES_RECOGNITION");
    }
    const offered: string[] = [];
    const offline: string[] = [];
    for (const { device, path } of planned) {
      if (installing.has(device.id)) {
        busy.push(device.id);
        continue;
      }
      if (!device.online) {
        offline.push(device.id);
        continue;
      }
      try {
        const sent = await this.send(path[0], device, actorId, { next: path[1] ?? null, pressedAt });
        if (sent) {
          offered.push(device.id);
        } else {
          ((await this.isOnline(device.id)) ? busy : offline).push(device.id);
        }
      } catch (error) {
        this.log.error(`could not update ${device.id}: ${(error as Error).message}`);
        failed.push(device.id);
      }
    }
    return { offered, failed, busy, offline };
  }

  @OnEvent(DEVICE_BEAT)
  async onBeat(beat: DeviceBeat): Promise<void> {
    await this.followUp(beat.deviceId).catch((error: Error) =>
      this.log.error(`the queued update step of ${beat.deviceId} failed: ${error.message}`),
    );
  }

  /** Carry an Update press on once the offer ahead is installed: offer the next step of the path found again
   *  from what the kiosk runs, or tell the presser it is done. A failed, rolled back, cut or expired offer
   *  ends the press (KEHOACH 7.7).
   */
  async followUp(deviceId: string): Promise<void> {
    const device = await this.db.device.findUnique({ where: { id: deviceId } });
    if (!device?.otaPressedAt) {
      return;
    }
    const current = await this.status(deviceId);
    if (current?.state === "WAITING" || current?.state === "TRIAL") {
      return;
    }
    const pressedAt = device.otaPressedAt;
    // Cleared ahead of the send, so two heartbeats in a row never carry one press on twice.
    const cleared = await this.db.device.updateMany({
      where: { id: deviceId, otaPressedAt: pressedAt },
      data: { otaNextReleaseId: null, otaPressedAt: null, otaPressedById: null },
    });
    if (cleared.count === 0 || current?.state !== "INSTALLED") {
      return;
    }
    const path = route(device, await this.releases(), pressedAt);
    if (!path) {
      if (device.otaPressedById) {
        const done = { deviceId, actorId: device.otaPressedById, firmware: device.fwVersion ?? "", models: device.modelVersion ?? "" };
        this.bus.emit(UPDATE_FINISHED, done satisfies UpdateFinished);
      }
      return;
    }
    const [step, next = null] = path;
    // A step the press did not name never moves the kiosk to another recognition model (KEHOACH 7.5).
    if (step.releaseId !== device.otaNextReleaseId && changesRecognition(device, step)) {
      this.log.warn(`the update of ${deviceId} stops ahead of ${step.version}, which changes recognition`);
      return;
    }
    const ended = { ...device, otaNextReleaseId: null, otaPressedAt: null, otaPressedById: null };
    await this.send(step, ended, device.otaPressedById ?? undefined, { next, pressedAt });
  }

  private releases(): Promise<Release[]> {
    return this.db.release.findMany({ where: { target: { in: [...PUBLISHED_TARGETS] } }, orderBy: { createdAt: "desc" } });
  }

  private async firmwareRuns(minFwVersion: string): Promise<boolean> {
    const firmware = await this.db.release.findMany({
      where: { target: "FIRMWARE", path: { not: null } },
      select: { version: true },
    });
    return firmware.some((one) => atLeast(one.version, minFwVersion));
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
    const reports = runs(device, release)
      ? []
      : await this.db.deviceEvent.findMany({
          where: {
            deviceId,
            type: { in: OTA_REPORTS },
            receivedAt: { gte: device.otaOfferedAt },
            OR: [{ cmdId: null }, { cmdId: release.releaseId }],
          },
          select: { type: true, cmdId: true, message: true, receivedAt: true },
        });
    const next = device.otaNextReleaseId
      ? await this.db.release.findUnique({ where: { releaseId: device.otaNextReleaseId } })
      : null;
    return { ...this.offerState({ ...device, otaOfferedAt: device.otaOfferedAt }, release, reports), next: next ? stepOf(next) : null };
  }

  // The rows of the KEHOACH 7.7 status table, top down; the first that holds is the answer.
  private offerState(
    device: Pick<Device, "fwVersion" | "modelVersion" | "fwOnTrial" | "bootedAt"> & { otaOfferedAt: Date },
    release: Release,
    reports: OtaReport[],
  ): OfferStatus {
    const base = {
      releaseId: release.releaseId,
      target: release.target,
      version: release.version,
      offeredAt: device.otaOfferedAt,
      busyUntil: null,
      next: null,
    };
    if (runs(device, release)) {
      // onTrial describes the running firmware (heartbeat contract), so only a firmware offer is ever on trial.
      const trial = release.target === "FIRMWARE" && device.fwOnTrial === true;
      return { ...base, state: trial ? "TRIAL" : "INSTALLED", reason: null };
    }
    const rolledBack = reportOn(reports, OTA_ROLLED_BACK, release.releaseId, device.otaOfferedAt);
    if (rolledBack) {
      return { ...base, state: "ROLLED_BACK", reason: rolledBack.message };
    }
    const failure = reportOn(reports, OTA_FAILED, release.releaseId, device.otaOfferedAt);
    if (failure) {
      return { ...base, state: "FAILED", reason: failure.message };
    }
    // Back on the old release after the offer and nothing reported: a cut download.
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

  // The approved kiosks inside the busy window of an offer they have not answered yet, or between the two
  // steps of one Update press (KEHOACH 7.7), in three reads.
  private async installing(): Promise<Set<string>> {
    const since = new Date(Date.now() - this.busyMs);
    const recent = await this.db.device.findMany({
      where: { status: "APPROVED", otaReleaseId: { not: null }, OR: [{ otaOfferedAt: { gt: since } }, { otaNextReleaseId: { not: null } }] },
      select: {
        id: true,
        fwVersion: true,
        modelVersion: true,
        fwOnTrial: true,
        bootedAt: true,
        otaReleaseId: true,
        otaOfferedAt: true,
        otaNextReleaseId: true,
      },
    });
    if (recent.length === 0) {
      return new Set();
    }
    const [releases, reports] = await Promise.all([
      this.db.release.findMany({
        where: { releaseId: { in: [...new Set(recent.map((one) => one.otaReleaseId as string))] } },
      }),
      this.db.deviceEvent.findMany({
        where: { deviceId: { in: recent.map((one) => one.id) }, type: { in: OTA_REPORTS }, receivedAt: { gt: since } },
        select: { deviceId: true, type: true, cmdId: true, receivedAt: true, message: true },
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
      const mine = reports.filter((event) => event.deviceId === one.id);
      const offer = this.offerState({ ...one, otaOfferedAt: offeredAt }, release, mine);
      const chained = one.otaNextReleaseId !== null && (offer.state === "TRIAL" || offer.state === "INSTALLED");
      if (offer.busyUntil || chained) {
        busy.add(one.id);
      }
    }
    return busy;
  }

  private async isOnline(deviceId: string): Promise<boolean> {
    const held = await this.db.device.findUnique({ where: { id: deviceId }, select: { online: true } });
    return held?.online ?? false;
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

  /**
   * Take the kiosk's one offer slot, then publish. The write is conditioned on the offer read, so two
   * presses at once cannot both send (KEHOACH 9.23 rule 3); null when the other one took it or the
   * kiosk dropped offline. The slot is taken ahead of the publish so no report can beat otaOfferedAt.
   */
  private async send(
    release: Release,
    device: Pick<Device, "id" | "otaReleaseId" | "otaOfferedAt" | "otaNextReleaseId" | "otaPressedAt" | "otaPressedById">,
    actorId?: string,
    press: { next: Release | null; pressedAt: Date | null } = { next: null, pressedAt: null },
  ): Promise<Date | null> {
    const deviceId = device.id;
    const offeredAt = new Date();
    const { next } = press;
    const taken = await this.db.device.updateMany({
      where: { id: deviceId, status: "APPROVED", online: true, otaOfferedAt: device.otaOfferedAt },
      data: {
        otaReleaseId: release.releaseId,
        otaOfferedAt: offeredAt,
        otaNextReleaseId: next?.releaseId ?? null,
        otaPressedAt: press.pressedAt,
        otaPressedById: press.pressedAt ? (actorId ?? null) : null,
      },
    });
    if (taken.count === 0) {
      return null;
    }
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
    try {
      await this.mqtt.publishDown("ota", deviceId, manifest);
    } catch (error) {
      // An offer that never left must not hold the slot for OTA_BUSY_MINUTES.
      await this.db.device.updateMany({
        where: { id: deviceId, otaOfferedAt: offeredAt },
        data: {
          otaReleaseId: device.otaReleaseId,
          otaOfferedAt: device.otaOfferedAt,
          otaNextReleaseId: device.otaNextReleaseId,
          otaPressedAt: device.otaPressedAt,
          otaPressedById: device.otaPressedById,
        },
      });
      throw error;
    }
    await this.db.release.update({ where: { releaseId: release.releaseId }, data: { rolloutState: "ROLLING" } });
    await this.audit.record({
      actorId,
      action: AUDIT_ACTIONS.RELEASE_OFFER,
      subject: AUDIT_SUBJECTS.DEVICE,
      subjectId: deviceId,
      meta: { releaseId: release.releaseId, target: release.target, version: release.version, next: next?.version ?? null },
    });
    this.log.log(`offered ${release.target} ${release.version} to ${deviceId}${next ? `, then ${next.target} ${next.version}` : ""}`);
    return offeredAt;
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
        if (sizeBytes - chunk.byteLength < HEAD_BYTES) {
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
    return { sha256: digest.digest("hex"), sizeBytes, head: Buffer.concat(head).subarray(0, HEAD_BYTES) };
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
