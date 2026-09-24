import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Device, DeviceEnrollment, FaceTemplate } from "@prisma/client";

import type { EnrollPayload } from "../../common/generated/enroll_payload.js";
import type { Env } from "../../config/env.schema.js";
import { PrismaService } from "../../database/prisma.service.js";
import { AUDIT_ACTIONS, AUDIT_SUBJECTS } from "../audit/audit-actions.js";
import { AuditService } from "../audit/audit.service.js";
import { MqttService } from "../mqtt/mqtt.service.js";
import { ConsentService } from "./consent.service.js";
import { openTemplate, sealTemplate } from "./template-crypto.js";

const NO_EMPLOYEE = 0;
const FIRST_TEMPLATE = 0;
// First key of pg_advisory_xact_lock, so one person's captures are taken one at a time.
const CAPTURE_LOCK = 75;

type Named = { fullName: string; code: string; embeddingVersion: string | null };
type Build = (version: number, deviceId: string) => Promise<EnrollPayload>;

export interface AssignableDevice {
  id: string;
  name: string | null;
  location: string | null;
}

/** Where one person stands on one kiosk. */
export interface KioskStanding extends AssignableDevice {
  state: DeviceEnrollment["state"];
}

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

  /** The kiosks a person can be put on, by name (KEHOACH 7.5). */
  assignable(): Promise<AssignableDevice[]> {
    return this.db.device.findMany({
      where: { status: "APPROVED" },
      select: { id: true, name: true, location: true },
      orderBy: [{ name: "asc" }, { id: "asc" }],
    });
  }

  /** Where a person stands on every kiosk still holding or awaiting them (KEHOACH 7.5). */
  async standing(employeeId: number): Promise<KioskStanding[]> {
    const rows = await this.db.deviceEnrollment.findMany({
      where: { employeeId, state: { not: "REVOKED" } },
      include: { device: { select: { name: true, location: true } } },
      orderBy: { deviceId: "asc" },
    });
    return rows.map((row) => ({
      id: row.deviceId,
      name: row.device.name,
      location: row.device.location,
      state: row.state,
    }));
  }

  /**
   * Put a person up for capture on a kiosk, so nobody types a UID. A pair
   * that already holds a face goes to RETAKE and keeps matching until the new
   * capture lands (KEHOACH 7.5).
   */
  async assign(deviceId: string, employeeId: number): Promise<DeviceEnrollment> {
    await this.consent.require(employeeId);
    const [device, employee] = await Promise.all([this.device(deviceId), this.employee(employeeId)]);
    const held = await this.db.deviceEnrollment.findUnique({
      where: { deviceId_employeeId: { deviceId, employeeId } },
    });
    const state = held?.state === "ENROLLED" || held?.state === "RETAKE" ? "RETAKE" : "ASSIGNED";
    const row = await this.db.deviceEnrollment.upsert({
      where: { deviceId_employeeId: { deviceId, employeeId } },
      update: { state },
      create: { deviceId, employeeId, state },
    });
    await this.send(deviceId, this.expect(employeeId, employee, await this.bump(device), deviceId));
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
      action: AUDIT_ACTIONS.BIOMETRIC_ERASE,
      subject: AUDIT_SUBJECTS.EMPLOYEE,
      subjectId: String(employeeId),
      meta: { devices: rows.length, why },
    });
    this.log.warn(`erased biometrics for ${employeeId} on ${rows.length} kiosk(s): ${why}`);
    return { devices: rows.length };
  }

  /** What an operator did at a kiosk: one captured sample, or a request the server decides (KEHOACH 7.5). */
  async takeReport(deviceId: string, report: EnrollPayload): Promise<void> {
    switch (report.op) {
      case "UPSERT":
        return this.takeSample(deviceId, report);
      case "RETAKE":
        return this.askedRetake(deviceId, report.employeeId);
      case "DELETE_EMPLOYEE":
        return this.askedRemove(deviceId, report.employeeId);
      default:
        this.log.warn(`${deviceId} sent ${report.op} up, which only the server sends`);
    }
  }

  /**
   * A door given the person opens a new session and it replaces every old
   * sample; a door already enrolled adds only samples of the session held.
   * Anything else is refused and the door is sent what the server holds.
   */
  private async takeSample(deviceId: string, report: EnrollPayload): Promise<void> {
    if (!report.embedding || report.scale === undefined) {
      this.log.warn(`${deviceId} reported a sample of ${report.employeeId} with no template`);
      return;
    }
    const employeeId = report.employeeId;
    const session = new Date(report.updatedAt);
    const sealed = sealTemplate(Buffer.from(report.embedding, "base64"), this.key());
    const verdict = await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CAPTURE_LOCK}::int, ${employeeId}::int)`;
      const pair = await tx.deviceEnrollment.findUnique({
        where: { deviceId_employeeId: { deviceId, employeeId } },
      });
      if (!pair) {
        return "stranger" as const;
      }
      const held = await tx.faceTemplate.findFirst({ where: { employeeId }, select: { capturedAt: true } });
      const current = held?.capturedAt.getTime() === session.getTime();
      const waiting = pair.state === "ASSIGNED" || pair.state === "RETAKE";
      if (waiting && current) {
        return "repeat" as const;
      }
      if (!(waiting || (pair.state === "ENROLLED" && current))) {
        return "refused" as const;
      }
      if (waiting && held) {
        await tx.faceTemplate.deleteMany({ where: { employeeId } });
      }
      const sample = {
        embedding: sealed,
        scale: report.scale ?? 0,
        quality: report.quality ?? null,
        capturedAt: session,
      };
      await tx.faceTemplate.upsert({
        where: { employeeId_templateIdx: { employeeId, templateIdx: report.templateIdx } },
        update: sample,
        create: { employeeId, templateIdx: report.templateIdx, ...sample },
      });
      await tx.deviceEnrollment.update({
        where: { deviceId_employeeId: { deviceId, employeeId } },
        data: { state: "ENROLLED", templateIdx: report.templateIdx },
      });
      if (report.embeddingVersion) {
        await tx.employee.update({ where: { id: employeeId }, data: { embeddingVersion: report.embeddingVersion } });
      }
      return waiting && held ? ("replaced" as const) : ("added" as const);
    });
    switch (verdict) {
      case "stranger":
        this.log.warn(`${deviceId} reported a face for ${employeeId}, which it was never given`);
        return;
      case "repeat":
        return;
      case "refused":
        this.log.warn(`${deviceId} captured ${employeeId} outside its turn, sending it the held samples`);
        return this.refuse(deviceId, employeeId);
      default:
        await this.spread(deviceId, employeeId, report.templateIdx, verdict === "replaced");
        this.log.log(`${deviceId} enrolled employee ${employeeId} sample ${report.templateIdx}`);
    }
  }

  private async askedRetake(deviceId: string, employeeId: number): Promise<void> {
    const pair = await this.db.deviceEnrollment.findUnique({
      where: { deviceId_employeeId: { deviceId, employeeId } },
    });
    const device = await this.device(deviceId);
    if (!pair || pair.state === "REVOKED" || !(await this.consent.live(employeeId))) {
      this.log.warn(`${deviceId} asked to retake ${employeeId}, who is not its to capture`);
      await this.send(deviceId, this.withdraw(employeeId, await this.bump(device), deviceId));
      return;
    }
    if (pair.state === "ENROLLED") {
      await this.db.deviceEnrollment.update({
        where: { deviceId_employeeId: { deviceId, employeeId } },
        data: { state: "RETAKE" },
      });
    }
    const employee = await this.employee(employeeId);
    await this.send(deviceId, this.expect(employeeId, employee, await this.bump(device), deviceId));
    await this.audit.record({
      action: AUDIT_ACTIONS.ENROLLMENT_RETAKE,
      subject: AUDIT_SUBJECTS.EMPLOYEE,
      subjectId: String(employeeId),
      meta: { deviceId, by: "kiosk" },
    });
  }

  private async askedRemove(deviceId: string, employeeId: number): Promise<void> {
    const pair = await this.db.deviceEnrollment.findUnique({
      where: { deviceId_employeeId: { deviceId, employeeId } },
    });
    if (!pair) {
      return;
    }
    await this.revoke(deviceId, employeeId);
    await this.audit.record({
      action: AUDIT_ACTIONS.ENROLLMENT_REMOVE,
      subject: AUDIT_SUBJECTS.EMPLOYEE,
      subjectId: String(employeeId),
      meta: { deviceId, by: "kiosk" },
    });
  }

  /** Bring one door back to what the server holds for one person (KEHOACH 7.5). */
  private async refuse(deviceId: string, employeeId: number): Promise<void> {
    const device = await this.device(deviceId);
    const pair = await this.db.deviceEnrollment.findUnique({
      where: { deviceId_employeeId: { deviceId, employeeId } },
      include: { employee: { select: { fullName: true, code: true, embeddingVersion: true } } },
    });
    await this.send(deviceId, this.dropAll(employeeId, await this.bump(device), deviceId));
    if (!pair || pair.state === "REVOKED") {
      return;
    }
    for (const build of await this.samplesFor(pair)) {
      await this.send(deviceId, await build(await this.bump(device), deviceId));
    }
  }

  /** Send a kiosk the whole roster it should hold. Convergence, not a delta:
   *  a delete sent once to an offline kiosk never lands, and the face of
   *  someone who left keeps opening the door (KEHOACH 7.5).
   */
  async resync(deviceId: string): Promise<number> {
    const device = await this.device(deviceId);
    const rows = await this.db.deviceEnrollment.findMany({
      where: { deviceId, state: { in: ["ASSIGNED", "ENROLLED", "RETAKE"] } },
      include: { employee: { select: { fullName: true, code: true, embeddingVersion: true } } },
      orderBy: { employeeId: "asc" },
    });
    const messages: Build[] = [];
    for (const row of rows) {
      const samples = await this.samplesFor(row);
      messages.push(...samples);
      // An upsert takes a person off the pending list, so the ask goes after it.
      if (row.state !== "ENROLLED" || samples.length === 0) {
        messages.push(async (version, to) => this.expect(row.employeeId, row.employee, version, to));
      }
    }
    // The repair path has to work from any state: a counter standing behind
    // its own roster would send a negative version and be refused.
    const top = Math.max(device.rosterVersion, messages.length);
    if (top !== device.rosterVersion) {
      await this.db.device.update({ where: { id: deviceId }, data: { rosterVersion: top } });
    }
    // Every message in the run carries the version the kiosk reaches by
    // applying it, so a dropped one leaves it short and the next beat retries.
    let version = top - messages.length;
    await this.send(deviceId, {
      op: "REPLACE_ALL",
      employeeId: NO_EMPLOYEE,
      templateIdx: FIRST_TEMPLATE,
      updatedAt: Date.now(),
      rosterVersion: version,
      deviceId,
    });
    for (const build of messages) {
      version += 1;
      await this.send(deviceId, await build(version, deviceId));
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

  /** One builder per sample the server holds for this person, each an audited read (KEHOACH 9.19). */
  private async samplesFor(row: DeviceEnrollment & { employee: Named }): Promise<Build[]> {
    if (!row.employee.embeddingVersion) {
      return [];
    }
    const held = await this.db.faceTemplate.findMany({
      where: { employeeId: row.employeeId },
      orderBy: { templateIdx: "asc" },
    });
    return held.map((sample) => (version: number, to: string) => this.upsertOf(row, sample, version, to));
  }

  private async upsertOf(
    row: DeviceEnrollment & { employee: Named },
    held: FaceTemplate,
    version: number,
    deviceId: string,
  ): Promise<EnrollPayload> {
    await this.audit.record({
      action: AUDIT_ACTIONS.BIOMETRIC_READ,
      subject: AUDIT_SUBJECTS.EMPLOYEE,
      subjectId: String(row.employeeId),
      meta: { deviceId, templateIdx: held.templateIdx },
    });
    return {
      op: "UPSERT",
      employeeId: row.employeeId,
      templateIdx: held.templateIdx,
      updatedAt: held.capturedAt.getTime(),
      embedding: openTemplate(held.embedding, this.key()).toString("base64"),
      scale: held.scale,
      embeddingVersion: row.employee.embeddingVersion ?? undefined,
      fullName: row.employee.fullName,
      rosterVersion: version,
      deviceId,
    };
  }

  private expect(employeeId: number, employee: Omit<Named, "embeddingVersion">, version: number, deviceId: string): EnrollPayload {
    return {
      op: "ASSIGN",
      employeeId,
      templateIdx: FIRST_TEMPLATE,
      updatedAt: Date.now(),
      fullName: employee.fullName,
      employeeCode: employee.code,
      rosterVersion: version,
      deviceId,
    };
  }

  private withdraw(employeeId: number, version: number, deviceId: string): EnrollPayload {
    return { op: "REVOKE", employeeId, templateIdx: FIRST_TEMPLATE, updatedAt: Date.now(), rosterVersion: version, deviceId };
  }

  private dropAll(employeeId: number, version: number, deviceId: string): EnrollPayload {
    return {
      op: "DELETE_EMPLOYEE",
      employeeId,
      templateIdx: FIRST_TEMPLATE,
      updatedAt: Date.now(),
      rosterVersion: version,
      deviceId,
    };
  }

  /**
   * The counter moves inside the statement, not in this process. Two people
   * enrolling at once each read the same old number, and the version a kiosk
   * is told to reach has to count every change (KEHOACH 6.2.6).
   */

  /** Each door would otherwise hold only what it captured itself, and no
   *  heartbeat reports that difference (KEHOACH 9.23 rule 7).
   */
  private async spread(fromDeviceId: string, employeeId: number, templateIdx: number, replaced: boolean): Promise<void> {
    const others = await this.db.deviceEnrollment.findMany({
      where: { employeeId, deviceId: { not: fromDeviceId }, state: { not: "REVOKED" } },
      include: {
        employee: { select: { fullName: true, code: true, embeddingVersion: true } },
      },
    });
    const sample = await this.db.faceTemplate.findUnique({
      where: { employeeId_templateIdx: { employeeId, templateIdx } },
    });
    if (!sample) {
      return;
    }
    for (const row of others) {
      const device = await this.db.device.findUnique({ where: { id: row.deviceId } });
      if (!device) {
        continue;
      }
      // A new session replaces the old samples on every door, not only the capturing one.
      if (replaced) {
        await this.send(row.deviceId, this.dropAll(employeeId, await this.bump(device), row.deviceId));
      }
      await this.send(row.deviceId, await this.upsertOf(row, sample, await this.bump(device), row.deviceId));
      // Left ASSIGNED, this door would ask for a face it now holds.
      await this.db.deviceEnrollment.update({
        where: { deviceId_employeeId: { deviceId: row.deviceId, employeeId } },
        data: { state: "ENROLLED", templateIdx },
      });
    }
  }

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
      throw new NotFoundException("DEVICE_NOT_FOUND");
    }
    return found;
  }

  private async employee(id: number) {
    const found = await this.db.employee.findUnique({ where: { id } });
    if (!found) {
      throw new NotFoundException("EMPLOYEE_NOT_FOUND");
    }
    return found;
  }
}
