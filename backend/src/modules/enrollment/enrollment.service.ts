import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { BiometricConsent, Device, DeviceEnrollment, FaceTemplate, Prisma } from "@prisma/client";
import pg from "pg";

import type { EnrollPayload } from "../../common/generated/enroll_payload.js";
import type { Viewer } from "../../common/scope/viewer.js";
import type { Env } from "../../config/env.schema.js";
import { PrismaService } from "../../database/prisma.service.js";
import { AUDIT_ACTIONS, AUDIT_SUBJECTS } from "../audit/audit-actions.js";
import { AuditService } from "../audit/audit.service.js";
import { MqttService } from "../mqtt/mqtt.service.js";
import { FEED, RealtimeGateway } from "../realtime/realtime.gateway.js";
import { ConsentService } from "./consent.service.js";
import { openTemplate, sealTemplate } from "./template-crypto.js";

const NO_EMPLOYEE = 0;
const FIRST_TEMPLATE = 0;
// First key of pg_advisory_xact_lock, so one person's captures are taken one at a time.
const CAPTURE_LOCK = 75;
const SCRUB_LOCK_WAIT_MS = 5000;

type Named = { fullName: string; code: string; embeddingVersion: string | null };
type Build = (version: number, deviceId: string) => Promise<EnrollPayload>;
type Door = { id: string; rosterVersion: number };

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
    private readonly feed: RealtimeGateway,
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

  /** Put many people up for capture on one kiosk. Only a pair that is absent or REVOKED turns ASSIGNED; the
   *  counter moves once by the batch, and each ASSIGN carries the version applying it reaches (KEHOACH 7.5).
   *  @ctx task | sends after the commit; a send that fails is left to the next heartbeat's resync
   *  @ret the roster version each person's ASSIGN carries, and the counter after the run
   */
  async assignMany(
    deviceId: string,
    people: readonly { id: number; code: string; fullName: string }[],
  ): Promise<{ versions: Map<number, number>; rosterVersion: number }> {
    const ids = people.map((one) => one.id);
    const written = await this.db.$transaction(async (tx) => {
      const put = await tx.$queryRaw<{ employeeId: number }[]>`
        INSERT INTO "DeviceEnrollment" ("deviceId", "employeeId", "state", "updatedAt")
        SELECT ${deviceId}, v."id", 'ASSIGNED'::"EnrollmentState", now() FROM unnest(${ids}::int[]) AS v("id")
        ON CONFLICT ("deviceId", "employeeId") DO UPDATE SET "state" = 'ASSIGNED'::"EnrollmentState", "updatedAt" = now()
         WHERE "DeviceEnrollment"."state" = 'REVOKED'::"EnrollmentState"
        RETURNING "employeeId"
      `;
      const [moved] = await tx.$queryRaw<{ rosterVersion: number }[]>`
        UPDATE "Device" SET "rosterVersion" = "rosterVersion" + ${put.length}::int, "updatedAt" = now()
         WHERE "id" = ${deviceId}
        RETURNING "rosterVersion"
      `;
      return { put: new Set(put.map((one) => one.employeeId)), top: moved?.rosterVersion ?? 0 };
    });
    const order = people.filter((one) => written.put.has(one.id));
    const first = written.top - order.length + 1;
    const versions = new Map(order.map((one, at) => [one.id, first + at]));
    for (const [at, one] of order.entries()) {
      await this.send(deviceId, this.expect(one.id, one, first + at, deviceId)).catch((error: Error) =>
        this.log.warn(`${deviceId} did not hear the assignment of ${one.id} yet: ${error.message}`),
      );
    }
    return { versions, rosterVersion: written.top };
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
  async erase(employeeId: number, actorId: string | undefined, why: string): Promise<{ devices: number }> {
    const doors = await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CAPTURE_LOCK}::int, ${employeeId}::int)`;
      return this.eraseIn(tx, employeeId);
    });
    await this.tellErased(employeeId, doors, actorId, why);
    return { devices: doors.length };
  }

  /**
   * Withdraw consent and erase the face in one transaction, so neither half
   * stands without the other. Asking again after a withdrawal erases again,
   * which is how a delete that never reached a kiosk gets another go.
   */
  async withdrawConsent(viewer: Viewer, employeeId: number): Promise<{ consent: BiometricConsent; devices: number }> {
    this.consent.mayRecordFor(viewer, employeeId);
    const { consent, doors, fresh } = await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CAPTURE_LOCK}::int, ${employeeId}::int)`;
      const live = await tx.biometricConsent.findFirst({
        where: { employeeId, state: "GRANTED" },
        orderBy: { grantedAt: "desc" },
      });
      const held =
        live ??
        (await tx.biometricConsent.findFirst({ where: { employeeId }, orderBy: { grantedAt: "desc" } }));
      if (!held) {
        throw new BadRequestException("CONSENT_NOT_GRANTED");
      }
      if (live) {
        await tx.biometricConsent.updateMany({
          where: { employeeId, state: "GRANTED" },
          data: { state: "WITHDRAWN", withdrawnAt: new Date() },
        });
      }
      const erased = await this.eraseIn(tx, employeeId);
      const after = await tx.biometricConsent.findUniqueOrThrow({ where: { id: held.id } });
      return { consent: after, doors: erased, fresh: live !== null };
    });
    if (fresh) {
      await this.audit.record({
        actorId: viewer.userId,
        action: AUDIT_ACTIONS.BIOMETRIC_CONSENT_WITHDRAW,
        subject: AUDIT_SUBJECTS.EMPLOYEE,
        subjectId: String(employeeId),
      });
    }
    await this.tellErased(employeeId, doors, viewer.userId, "consent withdrawn");
    return { consent, devices: doors.length };
  }

  /** The database half of an erase; the counter of every door moves with it. */
  private async eraseIn(tx: Prisma.TransactionClient, employeeId: number): Promise<Door[]> {
    const rows = await tx.deviceEnrollment.findMany({ where: { employeeId }, select: { deviceId: true } });
    await tx.faceTemplate.deleteMany({ where: { employeeId } });
    await tx.employee.update({ where: { id: employeeId }, data: { embeddingVersion: null } });
    await tx.deviceEnrollment.updateMany({ where: { employeeId }, data: { state: "REVOKED" } });
    if (rows.length === 0) {
      return [];
    }
    return tx.$queryRaw<Door[]>`
      UPDATE "Device" SET "rosterVersion" = "rosterVersion" + 1, "updatedAt" = now()
       WHERE "id" = ANY(${rows.map((row) => row.deviceId)}::text[])
      RETURNING "id", "rosterVersion"
    `;
  }

  // A door that misses the delete still reports the old counter, and its next heartbeat resyncs it.
  private async tellErased(employeeId: number, doors: Door[], actorId: string | undefined, why: string): Promise<void> {
    await this.scrubTemplates();
    for (const door of doors) {
      await this.send(door.id, this.dropAll(employeeId, door.rosterVersion, door.id)).catch((error: Error) =>
        this.log.warn(`${door.id} did not hear the erase of ${employeeId} yet: ${error.message}`),
      );
    }
    await this.audit.record({
      actorId,
      action: AUDIT_ACTIONS.BIOMETRIC_ERASE,
      subject: AUDIT_SUBJECTS.EMPLOYEE,
      subjectId: String(employeeId),
      meta: { devices: doors.length, why },
    });
    this.log.warn(`erased biometrics for ${employeeId} on ${doors.length} kiosk(s): ${why}`);
  }

  /** What an operator did at a kiosk: one captured sample, or a request the server decides (KEHOACH 7.5). */
  async takeReport(deviceId: string, report: EnrollPayload): Promise<void> {
    switch (report.op) {
      case "UPSERT":
        await this.takeSample(deviceId, report);
        break;
      case "RETAKE":
        await this.askedRetake(deviceId, report.employeeId);
        break;
      case "DELETE_EMPLOYEE":
        await this.askedRemove(deviceId, report.employeeId);
        break;
      default:
        this.log.warn(`${deviceId} sent ${report.op} up, which only the server sends`);
        return;
    }
    // No request carried the kiosk's report, so the change interceptor never announced it.
    this.feed.publish(FEED.change, { resources: ["enrollments"] }, report.employeeId);
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
    let overwrote = false;
    const verdict = await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CAPTURE_LOCK}::int, ${employeeId}::int)`;
      const pair = await tx.deviceEnrollment.findUnique({
        where: { deviceId_employeeId: { deviceId, employeeId } },
      });
      if (!pair) {
        return "stranger" as const;
      }
      // Consent can go while a kiosk is mid-capture; a face taken after that is not kept (KEHOACH 9.19).
      if ((await tx.biometricConsent.count({ where: { employeeId, state: "GRANTED" } })) === 0) {
        return "unconsented" as const;
      }
      const held = await tx.faceTemplate.findFirst({ where: { employeeId }, select: { capturedAt: true } });
      const current = held?.capturedAt.getTime() === session.getTime();
      const waiting = pair.state === "ASSIGNED" || pair.state === "RETAKE";
      if (waiting && current) {
        return "repeat" as const;
      }
      if (!(waiting || (pair.state === "ENROLLED" && current && this.opened(pair, session)))) {
        return "refused" as const;
      }
      if (waiting && held) {
        await tx.faceTemplate.deleteMany({ where: { employeeId } });
      } else {
        overwrote = (await tx.faceTemplate.count({ where: { employeeId, templateIdx: report.templateIdx } })) > 0;
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
        data: {
          state: "ENROLLED",
          templateIdx: report.templateIdx,
          ...(waiting ? { sessionAt: session, sessionOpenedAt: new Date() } : {}),
        },
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
      case "unconsented":
        this.log.warn(`${deviceId} captured ${employeeId}, who has no consent in force; told to drop it`);
        return this.send(deviceId, this.dropAll(employeeId, await this.bump(deviceId), deviceId));
      case "repeat":
        return;
      case "refused":
        this.log.warn(`${deviceId} captured ${employeeId} outside its turn, sending it the held samples`);
        return this.refuse(deviceId, employeeId);
      default:
        if (verdict === "replaced" || overwrote) {
          await this.scrubTemplates();
        }
        await this.spread(deviceId, employeeId, report.templateIdx, verdict === "replaced");
        this.log.log(`${deviceId} enrolled employee ${employeeId} sample ${report.templateIdx}`);
    }
  }

  // A deleted row lives on as a dead tuple, and a physical base copies pages whole (KEHOACH 9.22.7).
  // Its own connection carries the lock timeout, so a held lock never queues every reader behind it.
  private async scrubTemplates(): Promise<void> {
    const client = new pg.Client({
      connectionString: this.config.get("DATABASE_URL", { infer: true }),
      options: `-c lock_timeout=${SCRUB_LOCK_WAIT_MS}`,
    });
    const filenode = async () =>
      String((await client.query(`SELECT pg_relation_filenode('"FaceTemplate"') AS node`)).rows[0].node);
    try {
      await client.connect();
      const held = await filenode();
      await client.query('VACUUM (FULL) "FaceTemplate"');
      if ((await filenode()) === held) {
        this.log.error("FaceTemplate kept its file, so this role cannot rewrite it; the nightly backup does");
      }
    } catch (error) {
      this.log.error(`FaceTemplate not rewritten, the nightly backup rewrites it: ${(error as Error).message}`);
    } finally {
      await client.end().catch(() => undefined);
    }
  }

  // The session start reaches every kiosk with its samples, so matching it proves nothing on its own (KEHOACH 7.5).
  private opened(pair: DeviceEnrollment, session: Date): boolean {
    const windowMs = this.config.get("ENROLL_SESSION_MINUTES", { infer: true }) * 60_000;
    return (
      pair.sessionAt?.getTime() === session.getTime() &&
      pair.sessionOpenedAt !== null &&
      Date.now() - pair.sessionOpenedAt.getTime() <= windowMs
    );
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
    const held = await this.db.faceTemplate.findMany({
      where: { employeeId: { in: rows.filter((row) => row.employee.embeddingVersion).map((row) => row.employeeId) } },
      orderBy: [{ employeeId: "asc" }, { templateIdx: "asc" }],
    });
    const messages: Build[] = [];
    for (const row of rows) {
      const samples = this.buildsFor(row, held.filter((sample) => sample.employeeId === row.employeeId));
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
    return this.buildsFor(row, held);
  }

  private buildsFor(row: DeviceEnrollment & { employee: Named }, held: FaceTemplate[]): Build[] {
    if (!row.employee.embeddingVersion) {
      return [];
    }
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
      // A new session replaces the old samples on every door, not only the capturing one.
      if (replaced) {
        await this.send(row.deviceId, this.dropAll(employeeId, await this.bump(row.deviceId), row.deviceId));
      }
      await this.send(row.deviceId, await this.upsertOf(row, sample, await this.bump(row.deviceId), row.deviceId));
      // Left ASSIGNED, this door would ask for a face it now holds.
      await this.db.deviceEnrollment.update({
        where: { deviceId_employeeId: { deviceId: row.deviceId, employeeId } },
        data: { state: "ENROLLED", templateIdx },
      });
    }
  }

  private async bump(device: Pick<Device, "id"> | string): Promise<number> {
    const moved = await this.db.device.update({
      where: { id: typeof device === "string" ? device : device.id },
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
