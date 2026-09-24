import { createHash, timingSafeEqual } from "node:crypto";

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EventEmitter2 } from "@nestjs/event-emitter";
import type { Device, DeviceStatus, Prisma } from "@prisma/client";

import type { Page } from "../../common/dto/pagination.dto.js";
import { heartbeatSchema } from "../../common/generated/heartbeat.js";
import type { Env } from "../../config/env.schema.js";
import { PrismaService } from "../../database/prisma.service.js";
import { AUDIT_ACTIONS, AUDIT_SUBJECTS, type AuditAction } from "../audit/audit-actions.js";
import { AuditService } from "../audit/audit.service.js";
import { AuthService, deviceFingerprint } from "../auth/auth.service.js";
import { MqttService } from "../mqtt/mqtt.service.js";
import type {
  ApproveDeviceDto,
  ListDevicesDto,
  RegisterDeviceDto,
  UpdateDeviceDto,
} from "./dto/device.dto.js";

interface HeartbeatFacts {
  fwVersion: string;
  modelVersion: string;
}

/** `accepted` is the 202 of KEHOACH 7.3: ask again in `pollIntervalS`. The
 *  token only ever rides on the 200, once a person has said yes; `claimRenew`
 *  tells a kiosk its claim code is spent and it must show a new one.
 */
export interface Registration {
  accepted: boolean;
  deviceId: string;
  pollIntervalS?: number;
  token?: string;
  expiresInDays?: number;
  claimRenew?: boolean;
}

/** Named rather than taken whole: the row carries tokenHash, the hash of the
 *  credential a kiosk authenticates with (KEHOACH 7.5).
 */
const SHOWN = {
  id: true,
  serial: true,
  name: true,
  location: true,
  status: true,
  fwVersion: true,
  modelVersion: true,
  rosterVersion: true,
  lastSeenAt: true,
  online: true,
  approvedAt: true,
  revokedAt: true,
  readmittedAt: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** Raised when a kiosk's standing moves without a person's write, so an open dashboard hears it. */
export const DEVICE_CHANGED = "device.changed";

export interface DeviceChange {
  deviceId: string;
  status: DeviceStatus;
}

export type PublicDevice = Omit<
  Device,
  "tokenHash" | "prevTokenHash" | "claimHash" | "claimFailures"
>;

@Injectable()
export class DevicesService {
  private readonly log = new Logger(DevicesService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env, true>,
    private readonly broker: MqttService,
    private readonly bus: EventEmitter2,
  ) {}

  /**
   * A kiosk with an empty NVS asking for its credential. It arrives holding
   * only what its whole firmware batch holds, so nothing here may depend on
   * the caller being the machine it names (KEHOACH 7.3).
   */
  async register(body: RegisterDeviceDto): Promise<Registration> {
    if (!sameSecret(body.bootstrapToken, this.config.get("DEVICE_BOOTSTRAP_TOKEN", { infer: true }))) {
      throw new UnauthorizedException("DEVICE_BOOTSTRAP_REJECTED");
    }
    if (!heartbeatSchema.shape.deviceId.safeParse(body.deviceId).success) {
      throw new BadRequestException("DEVICE_ID_MALFORMED");
    }
    if (isServiceName(body.deviceId)) {
      throw new BadRequestException("DEVICE_ID_RESERVED");
    }
    const claim = claimFingerprint(body.deviceId, body.claimCode);
    const held = await this.db.device.findUnique({ where: { id: body.deviceId } });
    const waiting = this.waiting(body.deviceId);

    if (!held) {
      await this.db.device.create({
        data: {
          id: body.deviceId,
          status: "PENDING",
          fwVersion: body.fwVersion ?? null,
          claimHash: claim,
        },
      });
      await this.note(AUDIT_ACTIONS.DEVICE_REGISTER, body.deviceId, {
        fwVersion: body.fwVersion ?? null,
      });
      this.log.log(`${body.deviceId} asked to be let in, waiting for a person`);
      this.changed(body.deviceId, "PENDING");
      return waiting;
    }

    // An approved machine holding a token never asks again, so this call says
    // its storage is gone; it goes back to the queue a person works through.
    if (held.status === "APPROVED" && held.tokenHash !== null) {
      await this.db.device.update({
        where: { id: held.id },
        data: {
          status: "PENDING",
          tokenHash: null,
          prevTokenHash: null,
          approvedAt: null,
          online: false,
          claimHash: claim,
          claimFailures: 0,
        },
      });
      await this.note(AUDIT_ACTIONS.DEVICE_RESET, held.id, { from: "APPROVED" });
      this.log.warn(`${held.id} registered again while approved, sent back for approval`);
      this.changed(held.id, "PENDING");
      return waiting;
    }
    if (held.status === "APPROVED") {
      return this.issue(held, body.fwVersion);
    }
    if (held.status === "REVOKED") {
      await this.db.device.update({
        where: { id: held.id },
        data: {
          status: "PENDING",
          tokenHash: null,
          prevTokenHash: null,
          approvedAt: null,
          claimHash: claim,
          claimFailures: 0,
        },
      });
      await this.note(AUDIT_ACTIONS.DEVICE_REGISTER, held.id, { from: "REVOKED" });
      this.changed(held.id, "PENDING");
      return waiting;
    }
    return this.hold(held, claim);
  }

  // A code typed wrong too often is dead, and the kiosk is told to show a new one (KEHOACH 7.3).
  private async hold(device: Device, claim: string): Promise<Registration> {
    const waiting = this.waiting(device.id);
    if (device.claimHash === claim) {
      return device.claimFailures >= this.attempts() ? { ...waiting, claimRenew: true } : waiting;
    }
    await this.db.device.update({
      where: { id: device.id },
      data: { claimHash: claim, claimFailures: 0 },
    });
    return waiting;
  }

  private waiting(deviceId: string): Registration {
    return {
      accepted: true,
      deviceId,
      pollIntervalS: this.config.get("DEVICE_POLL_INTERVAL_S", { infer: true }),
    };
  }

  private attempts(): number {
    return this.config.get("DEVICE_CLAIM_ATTEMPTS", { infer: true });
  }

  private async issue(device: Device, fwVersion?: string): Promise<Registration> {
    const token = this.auth.signDevice({ deviceId: device.id });
    await this.db.device.update({
      where: { id: device.id },
      data: {
        tokenHash: deviceFingerprint(token),
        prevTokenHash: null,
        ...(fwVersion ? { fwVersion } : {}),
      },
    });
    this.log.log(`${device.id} collected its token`);
    return this.handed(device.id, token, {});
  }

  /**
   * Trade the ticket a kiosk presents for a fresh one. The ticket on the row
   * steps back to prevTokenHash; a kiosk asking again with that older ticket,
   * because the last answer never reached it, gets another fresh one and the
   * lost one dies (KEHOACH 7.3).
   */
  async renew(deviceId: string, presented: string): Promise<Registration> {
    const held = await this.db.device.findUnique({
      where: { id: deviceId },
      select: { tokenHash: true, prevTokenHash: true },
    });
    const shown = deviceFingerprint(presented);
    const current = held?.tokenHash === shown;
    if (!held || (!current && held.prevTokenHash !== shown)) {
      throw new UnauthorizedException("DEVICE_TOKEN_REJECTED");
    }
    const token = this.auth.signDevice({ deviceId });
    const moved = await this.db.device.updateMany({
      where: { id: deviceId, status: "APPROVED", tokenHash: held.tokenHash },
      data: {
        tokenHash: deviceFingerprint(token),
        prevTokenHash: current ? held.tokenHash : held.prevTokenHash,
      },
    });
    if (moved.count === 0) {
      throw new UnauthorizedException("DEVICE_TOKEN_REJECTED");
    }
    this.log.log(`${deviceId} renewed its token`);
    return this.handed(deviceId, token, { renewed: true });
  }

  private async handed(
    deviceId: string,
    token: string,
    meta: Record<string, boolean>,
  ): Promise<Registration> {
    const expiresInDays = this.config.get("DEVICE_TOKEN_TTL_DAYS", { infer: true });
    await this.note(AUDIT_ACTIONS.DEVICE_TOKEN_ISSUE, deviceId, { expiresInDays, ...meta });
    return { accepted: false, deviceId, token, expiresInDays };
  }

  private note(action: AuditAction, deviceId: string, meta: Prisma.InputJsonValue): Promise<void> {
    return this.audit.record({
      action,
      subject: AUDIT_SUBJECTS.DEVICE,
      subjectId: deviceId,
      meta,
    });
  }

  async list(query: ListDevicesDto): Promise<Page<PublicDevice>> {
    const where: Prisma.DeviceWhereInput = query.status ? { status: query.status } : {};
    const [rows, total] = await Promise.all([
      this.db.device.findMany({
        where,
        select: SHOWN,
        skip: query.skip,
        take: query.take,
        orderBy: [{ status: "asc" }, { id: "asc" }],
      }),
      this.db.device.count({ where }),
    ]);
    return { rows, total };
  }

  async get(id: string): Promise<PublicDevice> {
    const found = await this.db.device.findUnique({ where: { id }, select: SHOWN });
    if (!found) {
      throw new NotFoundException("DEVICE_NOT_FOUND");
    }
    return found;
  }

  async update(id: string, body: UpdateDeviceDto): Promise<PublicDevice> {
    await this.get(id);
    return this.db.device.update({ where: { id }, data: body, select: SHOWN });
  }

  /** Accept a machine: a person typed the claim code off its screen (KEHOACH 7.3). */
  async approve(id: string, body: ApproveDeviceDto): Promise<PublicDevice> {
    const held = await this.db.device.findUnique({
      where: { id },
      select: { claimHash: true, claimFailures: true, revokedAt: true, readmittedAt: true },
    });
    if (!held) {
      throw new NotFoundException("DEVICE_NOT_FOUND");
    }
    if (held.claimHash === null) {
      throw new ConflictException("DEVICE_CLAIM_MISSING");
    }
    if (held.claimFailures >= this.attempts()) {
      throw new ConflictException("DEVICE_CLAIM_LOCKED");
    }
    const { claimCode, ...named } = body;
    if (!sameSecret(claimFingerprint(id, claimCode), held.claimHash)) {
      await this.db.device.update({ where: { id }, data: { claimFailures: { increment: 1 } } });
      throw new BadRequestException("DEVICE_CLAIM_MISMATCH");
    }
    const now = new Date();
    const closesSpan = held.revokedAt !== null && held.readmittedAt === null;
    return this.db.device.update({
      where: { id },
      data: {
        ...named,
        status: "APPROVED",
        approvedAt: now,
        ...(closesSpan ? { readmittedAt: now } : {}),
        claimHash: null,
        claimFailures: 0,
      },
      select: SHOWN,
    });
  }

  /** Take a machine back: its ticket dies, its open session is closed, and it re-registers (KEHOACH 7.4). */
  async revoke(id: string): Promise<PublicDevice> {
    await this.get(id);
    const revoked = await this.db.device.update({
      where: { id },
      data: {
        status: "REVOKED",
        tokenHash: null,
        prevTokenHash: null,
        online: false,
        revokedAt: new Date(),
        readmittedAt: null,
      },
      select: SHOWN,
    });
    await this.broker.closeSession(id);
    this.changed(id, "REVOKED");
    return revoked;
  }

  private changed(deviceId: string, status: DeviceStatus): void {
    this.bus.emit(DEVICE_CHANGED, { deviceId, status } satisfies DeviceChange);
  }

  /** Record what a heartbeat says about a kiosk, creating its row if needed. */
  async applyHeartbeat(deviceId: string, beat: HeartbeatFacts, at: Date): Promise<void> {
    await this.seen(deviceId, at);
    await this.db.device.update({
      where: { id: deviceId },
      data: {
        fwVersion: beat.fwVersion,
        modelVersion: beat.modelVersion,
        lastSeenAt: at,
        online: true,
      },
    });
  }

  /** Follow the retained status topic, which the broker writes on a last will. */
  async setOnline(deviceId: string, online: boolean, at: Date): Promise<void> {
    await this.seen(deviceId, at);
    await this.db.device.update({ where: { id: deviceId }, data: { online, lastSeenAt: at } });
  }

  /** Whether a punch timed at ts falls in the span this kiosk stood outside the fleet (KEHOACH 7.3). */
  async outsideFleetAt(deviceId: string, ts: Date): Promise<boolean> {
    const held = await this.db.device.findUnique({
      where: { id: deviceId },
      select: { revokedAt: true, readmittedAt: true },
    });
    if (!held?.revokedAt || ts < held.revokedAt) {
      return false;
    }
    return held.readmittedAt === null || ts < held.readmittedAt;
  }

  /** Note that a device spoke; an unknown one lands at PENDING (KEHOACH 7.3). */
  async seen(deviceId: string, at: Date): Promise<void> {
    const known = await this.db.device.findUnique({ where: { id: deviceId } });
    if (!known) {
      this.log.warn(`${deviceId} spoke without a record, writing it as PENDING`);
    }
    await this.db.device.upsert({
      where: { id: deviceId },
      update: { lastSeenAt: at, online: true },
      create: { id: deviceId, lastSeenAt: at, online: true },
    });
  }
}

// The ACL grants fleet-wide rights to this prefix by username (KEHOACH 7.4).
const SERVICE_PREFIX = "svc-";

/** Whether a name is one the broker gives service rights to, which no device may hold. */
export function isServiceName(username: string): boolean {
  return username.toLowerCase().startsWith(SERVICE_PREFIX);
}

function claimFingerprint(deviceId: string, code: string): string {
  return createHash("sha256").update(`${deviceId}:${code}`).digest("hex");
}

/** Compare in constant time: a plain === leaks the shared secret one byte at
 *  a time to anyone who can measure the answer (KEHOACH 7.3).
 */
function sameSecret(given: string, held: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(held).digest();
  return timingSafeEqual(a, b);
}
