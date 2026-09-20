import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Device, DeviceEnrollment } from "@prisma/client";

import type { EnrollPayload } from "../../common/generated/enroll_payload.js";
import type { Env } from "../../config/env.schema.js";
import { PrismaService } from "../../database/prisma.service.js";
import { AuditService } from "../audit/audit.service.js";
import { MqttService } from "../mqtt/mqtt.service.js";
import { ConsentService } from "./consent.service.js";
import { openTemplate, sealTemplate } from "./template-crypto.js";

const NO_EMPLOYEE = 0;
const FIRST_TEMPLATE = 0;

@Injectable()
export class EnrollmentService {
  private readonly log = new Logger(EnrollmentService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly mqtt: MqttService,
    private readonly consent: ConsentService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Tell a kiosk to expect this person, so nobody types a UID (KEHOACH 7.5). */
  async assign(deviceId: string, employeeId: number): Promise<DeviceEnrollment> {
    await this.consent.require(employeeId);
    const [device, employee] = await Promise.all([this.device(deviceId), this.employee(employeeId)]);
    const row = await this.db.deviceEnrollment.upsert({
      where: { deviceId_employeeId: { deviceId, employeeId } },
      update: { state: "ASSIGNED" },
      create: { deviceId, employeeId, state: "ASSIGNED" },
    });
    const version = await this.bump(device);
    await this.send(deviceId, {
      op: "ASSIGN",
      employeeId,
      templateIdx: FIRST_TEMPLATE,
      updatedAt: Date.now(),
      fullName: employee.fullName,
      employeeCode: employee.code,
      rosterVersion: version,
      deviceId,
    });
    return row;
  }

  /** Withdraw a person from a kiosk; the kiosk drops any template it holds. */
  async revoke(deviceId: string, employeeId: number): Promise<DeviceEnrollment> {
    const device = await this.device(deviceId);
    const row = await this.db.deviceEnrollment.update({
      where: { deviceId_employeeId: { deviceId, employeeId } },
      data: { state: "REVOKED" },
    });
    const version = await this.bump(device);
    await this.send(deviceId, {
      op: "DELETE_EMPLOYEE",
      employeeId,
      templateIdx: FIRST_TEMPLATE,
      updatedAt: Date.now(),
      rosterVersion: version,
      deviceId,
    });
    return row;
  }

  /**
   * Erase a person's face on every kiosk holding it. The personnel record
   * stays; the biometric does not (Nghi dinh 13/2023, KEHOACH 9.19).
   */
  async erase(employeeId: number, actorId: string, why: string): Promise<{ devices: number }> {
    const rows = await this.db.deviceEnrollment.findMany({ where: { employeeId } });
    await this.db.faceTemplate.deleteMany({ where: { employeeId } });
    await this.db.employee.update({ where: { id: employeeId }, data: { embeddingVersion: null } });
    for (const row of rows) {
      const device = await this.db.device.findUnique({ where: { id: row.deviceId } });
      if (!device) {
        continue;
      }
      const version = await this.bump(device);
      await this.send(row.deviceId, {
        op: "DELETE_EMPLOYEE",
        employeeId,
        templateIdx: FIRST_TEMPLATE,
        updatedAt: Date.now(),
        rosterVersion: version,
        deviceId: row.deviceId,
      });
    }
    await this.db.deviceEnrollment.updateMany({ where: { employeeId }, data: { state: "REVOKED" } });
    await this.audit.record({
      actorId,
      action: "biometric.erase",
      target: String(employeeId),
      meta: { devices: rows.length, why },
    });
    this.log.warn(`erased biometrics for ${employeeId} on ${rows.length} kiosk(s): ${why}`);
    return { devices: rows.length };
  }

  /** Store what a kiosk says it captured, sealed, and mark the pair enrolled. */
  async takeReport(deviceId: string, report: EnrollPayload): Promise<void> {
    if (report.op !== "UPSERT" || !report.embedding || report.scale === undefined) {
      this.log.warn(`${deviceId} reported ${report.op}, which carries no template`);
      return;
    }
    const sealed = sealTemplate(Buffer.from(report.embedding, "base64"), this.key());
    await this.db.faceTemplate.upsert({
      where: {
        employeeId_templateIdx: {
          employeeId: report.employeeId,
          templateIdx: report.templateIdx,
        },
      },
      update: { embedding: sealed, scale: report.scale, quality: report.quality },
      create: {
        employeeId: report.employeeId,
        templateIdx: report.templateIdx,
        embedding: sealed,
        scale: report.scale,
        quality: report.quality,
        capturedAt: new Date(report.updatedAt),
      },
    });
    if (report.embeddingVersion) {
      await this.db.employee.update({
        where: { id: report.employeeId },
        data: { embeddingVersion: report.embeddingVersion },
      });
    }
    await this.db.deviceEnrollment.updateMany({
      where: { deviceId, employeeId: report.employeeId },
      data: { state: "ENROLLED", templateIdx: report.templateIdx },
    });
    this.log.log(`${deviceId} enrolled employee ${report.employeeId}`);
  }

  /** Send a kiosk the whole roster it should hold. Convergence, not a delta:
   *  a delete sent once to an offline kiosk never lands, and the face of
   *  someone who left keeps opening the door (KEHOACH 7.5).
   */
  async resync(deviceId: string): Promise<number> {
    const device = await this.device(deviceId);
    const rows = await this.db.deviceEnrollment.findMany({
      where: { deviceId, state: { in: ["ASSIGNED", "ENROLLED"] } },
      include: { employee: true },
      orderBy: { employeeId: "asc" },
    });
    // Every message in the run carries the version the kiosk reaches by
    // applying it, so a dropped one leaves it short and the next beat retries.
    let version = device.rosterVersion - rows.length;
    await this.send(deviceId, {
      op: "REPLACE_ALL",
      employeeId: NO_EMPLOYEE,
      templateIdx: FIRST_TEMPLATE,
      updatedAt: Date.now(),
      rosterVersion: version,
      deviceId,
    });
    for (const row of rows) {
      version += 1;
      await this.send(deviceId, await this.templateFor(row, version, deviceId));
    }
    this.log.log(`${deviceId} resynced to roster ${version}, ${rows.length} entries`);
    return version;
  }

  /** Bring a kiosk level when its heartbeat reports an older roster. */
  async converge(deviceId: string, reported: number | undefined): Promise<void> {
    const device = await this.db.device.findUnique({ where: { id: deviceId } });
    if (!device || reported === undefined || reported >= device.rosterVersion) {
      return;
    }
    this.log.warn(`${deviceId} is at roster ${reported}, server holds ${device.rosterVersion}`);
    await this.resync(deviceId);
  }

  private async templateFor(
    row: DeviceEnrollment & { employee: { fullName: string; code: string; embeddingVersion: string | null } },
    version: number,
    deviceId: string,
  ): Promise<EnrollPayload> {
    const held =
      row.templateIdx === null
        ? null
        : await this.db.faceTemplate.findUnique({
            where: {
              employeeId_templateIdx: { employeeId: row.employeeId, templateIdx: row.templateIdx },
            },
          });
    if (!held || !row.employee.embeddingVersion) {
      return {
        op: "ASSIGN",
        employeeId: row.employeeId,
        templateIdx: FIRST_TEMPLATE,
        updatedAt: Date.now(),
        fullName: row.employee.fullName,
        employeeCode: row.employee.code,
        rosterVersion: version,
        deviceId,
      };
    }
    // Handing a template to a kiosk is a read of sensitive data, and the log
    // has to cover reads, not only writes (KEHOACH 9.19).
    await this.audit.record({
      action: "biometric.read",
      target: String(row.employeeId),
      meta: { deviceId, templateIdx: held.templateIdx },
    });
    return {
      op: "UPSERT",
      employeeId: row.employeeId,
      templateIdx: held.templateIdx,
      updatedAt: held.updatedAt.getTime(),
      embedding: openTemplate(held.embedding, this.key()).toString("base64"),
      scale: held.scale,
      embeddingVersion: row.employee.embeddingVersion,
      fullName: row.employee.fullName,
      rosterVersion: version,
      deviceId,
    };
  }

  /**
   * The counter moves inside the statement, not in this process. Two people
   * enrolling at once each read the same old number, and the version a kiosk
   * is told to reach has to count every change (KEHOACH 6.2.6).
   */
  private async bump(device: Device): Promise<number> {
    const moved = await this.db.device.update({
      where: { id: device.id },
      data: { rosterVersion: { increment: 1 } },
      select: { rosterVersion: true },
    });
    return moved.rosterVersion;
  }

  private send(deviceId: string, payload: EnrollPayload): Promise<void> {
    return this.mqtt.publishDown("enroll", deviceId, payload);
  }

  private key(): string {
    return this.config.get("TEMPLATE_ENCRYPTION_KEY", { infer: true });
  }

  private async device(id: string): Promise<Device> {
    const found = await this.db.device.findUnique({ where: { id } });
    if (!found) {
      throw new NotFoundException(`no device ${id}`);
    }
    return found;
  }

  private async employee(id: number) {
    const found = await this.db.employee.findUnique({ where: { id } });
    if (!found) {
      throw new NotFoundException(`no employee ${id}`);
    }
    return found;
  }
}
