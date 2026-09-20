import { createHash, timingSafeEqual } from "node:crypto";

import { Injectable, Logger, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Device, Prisma } from "@prisma/client";

import type { Page } from "../../common/dto/pagination.dto.js";
import type { Env } from "../../config/env.schema.js";
import { PrismaService } from "../../database/prisma.service.js";
import { AUDIT_ACTIONS, AUDIT_SUBJECTS, type AuditAction } from "../audit/audit-actions.js";
import { AuditService } from "../audit/audit.service.js";
import { AuthService } from "../auth/auth.service.js";
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

/** `accepted` is the 202 of KEHOACH 7.3: keep asking. The token only ever
 *  rides on the 200, once a person has said yes.
 */
export interface Registration {
  accepted: boolean;
  deviceId: string;
  token?: string;
  expiresInDays?: number;
}

@Injectable()
export class DevicesService {
  private readonly log = new Logger(DevicesService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env, true>,
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
    const held = await this.db.device.findUnique({ where: { id: body.deviceId } });
    const waiting: Registration = { accepted: true, deviceId: body.deviceId };

    if (!held) {
      await this.db.device.create({
        data: { id: body.deviceId, status: "PENDING", fwVersion: body.fwVersion ?? null },
      });
      await this.note(AUDIT_ACTIONS.DEVICE_REGISTER, body.deviceId, {
        fwVersion: body.fwVersion ?? null,
      });
      this.log.log(`${body.deviceId} asked to be let in, waiting for a person`);
      return waiting;
    }

    // An approved machine holding a token never asks again, so this call says
    // its storage is gone; it goes back to the queue a person works through.
    if (held.status === "APPROVED" && held.tokenHash !== null) {
      await this.db.device.update({
        where: { id: held.id },
        data: { status: "PENDING", tokenHash: null, approvedAt: null, online: false },
      });
      await this.note(AUDIT_ACTIONS.DEVICE_RESET, held.id, { from: "APPROVED" });
      this.log.warn(`${held.id} registered again while approved, sent back for approval`);
      return waiting;
    }
    if (held.status === "APPROVED") {
      return this.issue(held, body.fwVersion);
    }
    if (held.status === "REVOKED") {
      await this.db.device.update({
        where: { id: held.id },
        data: { status: "PENDING", tokenHash: null, approvedAt: null },
      });
      await this.note(AUDIT_ACTIONS.DEVICE_REGISTER, held.id, { from: "REVOKED" });
    }
    return waiting;
  }

  private async issue(device: Device, fwVersion?: string): Promise<Registration> {
    const token = this.auth.signDevice({ deviceId: device.id });
    await this.db.device.update({
      where: { id: device.id },
      data: { tokenHash: fingerprint(token), ...(fwVersion ? { fwVersion } : {}) },
    });
    await this.note(AUDIT_ACTIONS.DEVICE_TOKEN_ISSUE, device.id, {
      expiresInDays: this.config.get("DEVICE_TOKEN_TTL_DAYS", { infer: true }),
    });
    this.log.log(`${device.id} collected its token`);
    return {
      accepted: false,
      deviceId: device.id,
      token,
      expiresInDays: this.config.get("DEVICE_TOKEN_TTL_DAYS", { infer: true }),
    };
  }

  private note(action: AuditAction, deviceId: string, meta: Prisma.InputJsonValue): Promise<void> {
    return this.audit.record({
      action,
      subject: AUDIT_SUBJECTS.DEVICE,
      subjectId: deviceId,
      meta,
    });
  }

  async list(query: ListDevicesDto): Promise<Page<Device>> {
    const where: Prisma.DeviceWhereInput = query.status ? { status: query.status } : {};
    const [rows, total] = await Promise.all([
      this.db.device.findMany({
        where,
        skip: query.skip,
        take: query.take,
        orderBy: [{ status: "asc" }, { id: "asc" }],
      }),
      this.db.device.count({ where }),
    ]);
    return { rows, total };
  }

  async get(id: string): Promise<Device> {
    const found = await this.db.device.findUnique({ where: { id } });
    if (!found) {
      throw new NotFoundException(`no device ${id}`);
    }
    return found;
  }

  async update(id: string, body: UpdateDeviceDto): Promise<Device> {
    await this.get(id);
    return this.db.device.update({ where: { id }, data: body });
  }

  /** Accept a machine: a person has matched the id on its screen (KEHOACH 7.3). */
  async approve(id: string, body: ApproveDeviceDto): Promise<Device> {
    await this.get(id);
    return this.db.device.update({
      where: { id },
      data: { ...body, status: "APPROVED", approvedAt: new Date() },
    });
  }

  /** Take a machine back; its credentials stop working and it re-registers. */
  async revoke(id: string): Promise<Device> {
    await this.get(id);
    return this.db.device.update({
      where: { id },
      data: { status: "REVOKED", tokenHash: null, online: false },
    });
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

function fingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Compare in constant time: a plain === leaks the shared secret one byte at
 *  a time to anyone who can measure the answer (KEHOACH 7.3).
 */
function sameSecret(given: string, held: string): boolean {
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(held).digest();
  return timingSafeEqual(a, b);
}
