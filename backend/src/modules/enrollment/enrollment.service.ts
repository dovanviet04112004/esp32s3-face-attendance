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
type Build = (version: number, deviceId: string) => EnrollPayload | Promise<EnrollPayload>;
type Door = { id: string; rosterVersion: number };
type Told<T> = { builds: Build[]; value: T };
// A door the person gains while the locks are taken widens the set, and the erase starts again.
type Erased<T> = { widen: string[] } | { widen: null; value: T; doors: Door[] };
// A kiosk's newest resync: its first number, when its last message left, the number heard since.
type Run = { from: number; endedAt: number; heard?: number };

// A kiosk refuses a template of another recognition model; a side that cannot say is taken to match (KEHOACH 7.5).
function otherModel(kiosk: string | null, held: string | null): boolean {
  return kiosk !== null && held !== null && kiosk !== held;
}

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
  // One sender per kiosk (KEHOACH 9.23). Held in this process: one api holds the broker session.
  // Lock order: kiosks in id order, then a person's CAPTURE_LOCK.
  private readonly doors = new Map<string, Promise<void>>();
  private readonly resyncing = new Map<string, number>();
  private readonly runs = new Map<string, Run>();

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
    const [, employee] = await Promise.all([this.device(deviceId), this.employee(employeeId)]);
    return this.tell(deviceId, async (tx) => {
      const held = await tx.deviceEnrollment.findUnique({
        where: { deviceId_employeeId: { deviceId, employeeId } },
      });
      const state = held?.state === "ENROLLED" || held?.state === "RETAKE" ? "RETAKE" : "ASSIGNED";
      const row = await tx.deviceEnrollment.upsert({
        where: { deviceId_employeeId: { deviceId, employeeId } },
        update: { state },
        create: { deviceId, employeeId, state },
      });
      return { value: row, builds: [(version, to) => this.expect(employeeId, employee, version, to)] };
    });
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
    return this.atDoors([deviceId], async () => {
      const written = await this.db.$transaction(async (tx) => {
        const put = await tx.$queryRaw<{ employeeId: number }[]>`
          INSERT INTO "DeviceEnrollment" ("deviceId", "employeeId", "state", "updatedAt")
          SELECT ${deviceId}, v."id", 'ASSIGNED'::"EnrollmentState", now() FROM unnest(${ids}::int[]) AS v("id")
          ON CONFLICT ("deviceId", "employeeId") DO UPDATE SET "state" = 'ASSIGNED'::"EnrollmentState", "updatedAt" = now()
           WHERE "DeviceEnrollment"."state" = 'REVOKED'::"EnrollmentState"
          RETURNING "employeeId"
        `;
        const kept = new Set(put.map((one) => one.employeeId));
        const order = people.filter((one) => kept.has(one.id));
        return { order, top: await this.reserve(tx, deviceId, order.length) };
      });
      const { order, top } = written;
      const first = top - order.length + 1;
      await this.deliver(
        deviceId,
        order.map((one) => (version: number, to: string) => this.expect(one.id, one, version, to)),
        top,
      ).catch((error: Error) => this.log.warn(`${deviceId} did not hear its assignments yet: ${error.message}`));
      return { versions: new Map(order.map((one, at) => [one.id, first + at])), rosterVersion: top };
    });
  }

  /** Withdraw a person from a kiosk; the kiosk drops any template it holds. */
  async revoke(deviceId: string, employeeId: number): Promise<DeviceEnrollment> {
    await this.device(deviceId);
    return this.tell(deviceId, async (tx) => ({
      value: await tx.deviceEnrollment.update({
        where: { deviceId_employeeId: { deviceId, employeeId } },
        data: { state: "REVOKED" },
      }),
      builds: [(version, to) => this.dropAll(employeeId, version, to)],
    }));
  }

  /**
   * Erase a person's face on every kiosk holding it. The personnel record
   * stays; the biometric does not (Nghi dinh 13/2023, KEHOACH 9.19).
   */
  async erase(employeeId: number, actorId: string | undefined, why: string): Promise<{ devices: number }> {
    const { doors } = await this.eraseWith(employeeId, async () => undefined);
    await this.noteErased(employeeId, doors, actorId, why);
    return { devices: doors.length };
  }

  /**
   * Withdraw consent and erase the face in one transaction, so neither half
   * stands without the other. Asking again after a withdrawal erases again,
   * which is how a delete that never reached a kiosk gets another go.
   */
  async withdrawConsent(viewer: Viewer, employeeId: number): Promise<{ consent: BiometricConsent; devices: number }> {
    this.consent.mayRecordFor(viewer, employeeId);
    const { value, doors } = await this.eraseWith(employeeId, async (tx) => {
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
      return { heldId: held.id, fresh: live !== null };
    });
    const consent = await this.db.biometricConsent.findUniqueOrThrow({ where: { id: value.heldId } });
    if (value.fresh) {
      await this.audit.record({
        actorId: viewer.userId,
        action: AUDIT_ACTIONS.BIOMETRIC_CONSENT_WITHDRAW,
        subject: AUDIT_SUBJECTS.EMPLOYEE,
        subjectId: String(employeeId),
      });
    }
    await this.noteErased(employeeId, doors, viewer.userId, "consent withdrawn");
    return { consent, devices: doors.length };
  }

  /** Run `first`, erase the person and tell every door holding them, under all those doors' locks. */
  private async eraseWith<T>(
    employeeId: number,
    first: (tx: Prisma.TransactionClient) => Promise<T>,
  ): Promise<{ value: T; doors: Door[] }> {
    let doors = await this.doorsOf(this.db, employeeId);
    for (;;) {
      const locked = doors;
      const ran = await this.atDoors(locked, async () => {
        const done = await this.db.$transaction(async (tx): Promise<Erased<T>> => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${CAPTURE_LOCK}::int, ${employeeId}::int)`;
          const now = await this.doorsOf(tx, employeeId);
          if (now.some((id) => !locked.includes(id))) {
            return { widen: now };
          }
          const value = await first(tx);
          return { widen: null, value, doors: await this.eraseIn(tx, employeeId, now) };
        });
        if (done.widen !== null) {
          return done;
        }
        // A door that misses the delete still reports the old counter, and its next heartbeat resyncs it.
        for (const door of done.doors) {
          await this.deliver(door.id, [(version, to) => this.dropAll(employeeId, version, to)], door.rosterVersion).catch(
            (error: Error) => this.log.warn(`${door.id} did not hear the erase of ${employeeId} yet: ${error.message}`),
          );
        }
        return done;
      });
      if (ran.widen === null) {
        return ran;
      }
      doors = [...new Set([...locked, ...ran.widen])];
    }
  }

  private async doorsOf(db: Prisma.TransactionClient, employeeId: number): Promise<string[]> {
    const rows = await db.deviceEnrollment.findMany({ where: { employeeId }, select: { deviceId: true } });
    return rows.map((row) => row.deviceId);
  }

  /** The database half of an erase; the counter of every door moves with it. */
  private async eraseIn(tx: Prisma.TransactionClient, employeeId: number, doorIds: string[]): Promise<Door[]> {
    await tx.faceTemplate.deleteMany({ where: { employeeId } });
    await tx.employee.update({ where: { id: employeeId }, data: { embeddingVersion: null } });
    await tx.deviceEnrollment.updateMany({ where: { employeeId }, data: { state: "REVOKED" } });
    if (doorIds.length === 0) {
      return [];
    }
    return tx.$queryRaw<Door[]>`
      UPDATE "Device" SET "rosterVersion" = "rosterVersion" + 1, "updatedAt" = now()
       WHERE "id" = ANY(${doorIds}::text[])
      RETURNING "id", "rosterVersion"
    `;
  }

  private async noteErased(employeeId: number, doors: Door[], actorId: string | undefined, why: string): Promise<void> {
    await this.scrubTemplates();
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
        return this.say(deviceId, (version, to) => this.dropAll(employeeId, version, to));
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
    await this.device(deviceId);
    const taken = await this.tell(deviceId, async (tx): Promise<Told<boolean>> => {
      const pair = await tx.deviceEnrollment.findUnique({
        where: { deviceId_employeeId: { deviceId, employeeId } },
        include: { employee: { select: { fullName: true, code: true } } },
      });
      if (!pair || pair.state === "REVOKED" || !(await this.consent.live(employeeId))) {
        return { value: false, builds: [(version, to) => this.withdraw(employeeId, version, to)] };
      }
      if (pair.state === "ENROLLED") {
        await tx.deviceEnrollment.update({
          where: { deviceId_employeeId: { deviceId, employeeId } },
          data: { state: "RETAKE" },
        });
      }
      return { value: true, builds: [(version, to) => this.expect(employeeId, pair.employee, version, to)] };
    });
    if (!taken) {
      this.log.warn(`${deviceId} asked to retake ${employeeId}, who is not its to capture`);
      return;
    }
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
    await this.tell(deviceId, async (tx) => {
      const pair = await tx.deviceEnrollment.findUnique({
        where: { deviceId_employeeId: { deviceId, employeeId } },
        include: { employee: { select: { fullName: true, code: true, embeddingVersion: true } } },
      });
      const builds: Build[] = [(version, to) => this.dropAll(employeeId, version, to)];
      if (pair && pair.state !== "REVOKED") {
        builds.push(...(await this.samplesFor(tx, pair)));
      }
      return { value: undefined, builds };
    });
  }

  /** Send a kiosk the whole roster it should hold, numbered above `floor` (KEHOACH 7.5).
   *  @ctx task | blocking | takes the kiosk's lock
   */
  async resync(deviceId: string, floor = 0): Promise<number> {
    await this.device(deviceId);
    this.resyncing.set(deviceId, (this.resyncing.get(deviceId) ?? 0) + 1);
    try {
      return await this.atDoors([deviceId], () => this.replay(deviceId, floor));
    } finally {
      const left = (this.resyncing.get(deviceId) ?? 1) - 1;
      if (left > 0) {
        this.resyncing.set(deviceId, left);
      } else {
        this.resyncing.delete(deviceId);
      }
    }
  }

  // Read the roster under the kiosk's lock, so nothing sent to it can fall between the read and the run.
  private async replay(deviceId: string, floor: number): Promise<number> {
    const device = await this.device(deviceId);
    const rows = await this.db.deviceEnrollment.findMany({
      where: { deviceId, state: { in: ["ASSIGNED", "ENROLLED", "RETAKE"] } },
      include: { employee: { select: { fullName: true, code: true, embeddingVersion: true } } },
      orderBy: { employeeId: "asc" },
    });
    // A person whose templates the kiosk would refuse is asked for again.
    const usable = (row: (typeof rows)[number]) =>
      row.employee.embeddingVersion !== null && !otherModel(device.embeddingVersion, row.employee.embeddingVersion);
    const held = await this.db.faceTemplate.findMany({
      where: { employeeId: { in: rows.filter(usable).map((row) => row.employeeId) } },
      orderBy: [{ employeeId: "asc" }, { templateIdx: "asc" }],
    });
    const builds: Build[] = [];
    const waiting: number[] = [];
    for (const row of rows) {
      const samples = usable(row) ? this.buildsFor(row, held.filter((sample) => sample.employeeId === row.employeeId)) : [];
      builds.push(...samples);
      // An upsert takes a person off the pending list, so the ask goes after it.
      if (row.state !== "ENROLLED" || samples.length === 0) {
        builds.push((version, to) => this.expect(row.employeeId, row.employee, version, to));
      }
      if (row.state !== "ASSIGNED" && samples.length === 0) {
        waiting.push(row.employeeId);
      }
    }
    const top = await this.db.$transaction(async (tx) => {
      await tx.deviceEnrollment.updateMany({
        where: { deviceId, employeeId: { in: waiting }, state: { in: ["ENROLLED", "RETAKE"] } },
        data: { state: "ASSIGNED" },
      });
      return this.reserve(tx, deviceId, builds.length + 1, floor);
    });
    // Every message carries the number the kiosk reaches by applying it, so a dropped one leaves it short.
    const base = top - builds.length;
    await this.mqtt.publishDown("enroll", deviceId, {
      op: "REPLACE_ALL",
      employeeId: NO_EMPLOYEE,
      templateIdx: FIRST_TEMPLATE,
      updatedAt: Date.now(),
      rosterVersion: base,
      deviceId,
    } satisfies EnrollPayload);
    await this.deliver(deviceId, builds, top);
    this.runs.set(deviceId, { from: base, endedAt: Date.now() });
    if (waiting.length > 0) {
      this.feed.publish(FEED.change, { resources: ["enrollments"] }, waiting);
    }
    this.log.log(`${deviceId} resynced to roster ${top}, ${rows.length} entries, ${waiting.length} to capture again`);
    return top;
  }

  /** Bring a kiosk level when its heartbeat names another roster number, lower or higher (KEHOACH 9.23).
   *  @ctx task | blocking | takes the kiosk's lock when it resyncs
   */
  async converge(deviceId: string, reported: number | undefined, heardAt = new Date()): Promise<void> {
    if (reported === undefined || this.resyncing.has(deviceId)) {
      return;
    }
    const device = await this.db.device.findUnique({ where: { id: deviceId }, select: { rosterVersion: true } });
    if (!device) {
      return;
    }
    const last = this.runs.get(deviceId);
    if (reported === device.rosterVersion) {
      this.runs.delete(deviceId);
      return;
    }
    if (last && heardAt.getTime() <= last.endedAt) {
      return;
    }
    // Still climbing through the last run: one resync per kiosk at a time, and a stalled one is resent.
    if (last && reported >= last.from && reported < device.rosterVersion && reported !== last.heard) {
      last.heard = reported;
      return;
    }
    this.log.warn(`${deviceId} is at roster ${reported}, server holds ${device.rosterVersion}`);
    await this.resync(deviceId, reported);
  }

  /** One builder per sample the server holds for this person, each an audited read (KEHOACH 9.19). */
  private async samplesFor(db: Prisma.TransactionClient, row: DeviceEnrollment & { employee: Named }): Promise<Build[]> {
    if (!row.employee.embeddingVersion) {
      return [];
    }
    const held = await db.faceTemplate.findMany({
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

  /** Each door would otherwise hold only what it captured itself, and no
   *  heartbeat reports that difference (KEHOACH 9.23 rule 7).
   */
  private async spread(fromDeviceId: string, employeeId: number, templateIdx: number, replaced: boolean): Promise<void> {
    const others = await this.db.deviceEnrollment.findMany({
      where: { employeeId, deviceId: { not: fromDeviceId }, state: { not: "REVOKED" } },
      include: {
        employee: { select: { fullName: true, code: true, embeddingVersion: true } },
        device: { select: { embeddingVersion: true } },
      },
    });
    const sample = await this.db.faceTemplate.findUnique({
      where: { employeeId_templateIdx: { employeeId, templateIdx } },
    });
    if (!sample) {
      return;
    }
    for (const row of others) {
      if (otherModel(row.device.embeddingVersion, row.employee.embeddingVersion)) {
        await this.unservable(row.deviceId, employeeId);
        continue;
      }
      await this.tell(row.deviceId, async (tx) => {
        // Left ASSIGNED, this door would ask for a face it now holds.
        const moved = await tx.deviceEnrollment.updateMany({
          where: { deviceId: row.deviceId, employeeId, state: { not: "REVOKED" } },
          data: { state: "ENROLLED", templateIdx },
        });
        const builds: Build[] = [];
        if (moved.count > 0) {
          // A new session replaces the old samples on every door, not only the capturing one.
          if (replaced) {
            builds.push((version, to) => this.dropAll(employeeId, version, to));
          }
          builds.push((version, to) => this.upsertOf(row, sample, version, to));
        }
        return { value: undefined, builds };
      });
    }
  }

  // The door keeps the face of its own model; the server has none of that model left to send it.
  private async unservable(deviceId: string, employeeId: number): Promise<void> {
    await this.tell(deviceId, async (tx) => {
      await tx.deviceEnrollment.updateMany({
        where: { deviceId, employeeId, state: { in: ["ENROLLED", "RETAKE"] } },
        data: { state: "ASSIGNED" },
      });
      return { value: undefined, builds: [] };
    });
  }

  /** Write and reserve one number per message in one transaction, then publish them in order (KEHOACH 9.23). */
  private tell<T>(deviceId: string, write: (tx: Prisma.TransactionClient) => Promise<Told<T>>): Promise<T> {
    return this.atDoors([deviceId], async () => {
      const told = await this.db.$transaction(async (tx) => {
        const said = await write(tx);
        return { ...said, top: await this.reserve(tx, deviceId, said.builds.length) };
      });
      await this.deliver(deviceId, told.builds, told.top);
      return told.value;
    });
  }

  private say(deviceId: string, ...builds: Build[]): Promise<void> {
    return this.tell(deviceId, async () => ({ value: undefined, builds }));
  }

  /** Move the counter past `floor` by `count` inside the statement (KEHOACH 9.23 rule 2); answers the last number. */
  private async reserve(db: Prisma.TransactionClient, deviceId: string, count: number, floor = 0): Promise<number> {
    const [moved] = await db.$queryRaw<{ rosterVersion: number }[]>`
      UPDATE "Device" SET "rosterVersion" = GREATEST("rosterVersion", ${floor}::int) + ${count}::int, "updatedAt" = now()
       WHERE "id" = ${deviceId}
      RETURNING "rosterVersion"
    `;
    if (!moved) {
      throw new NotFoundException("DEVICE_NOT_FOUND");
    }
    return moved.rosterVersion;
  }

  // The caller holds the kiosk's lock; the run ends at top, one number per message.
  private async deliver(deviceId: string, builds: readonly Build[], top: number): Promise<void> {
    let version = top - builds.length;
    for (const build of builds) {
      version += 1;
      await this.mqtt.publishDown("enroll", deviceId, await build(version, deviceId));
    }
  }

  private async atDoors<T>(deviceIds: readonly string[], work: () => Promise<T>): Promise<T> {
    const held: (() => void)[] = [];
    try {
      for (const id of [...new Set(deviceIds)].sort()) {
        held.push(await this.lock(id));
      }
      return await work();
    } finally {
      held.reverse().forEach((release) => release());
    }
  }

  private async lock(deviceId: string): Promise<() => void> {
    const ahead = this.doors.get(deviceId) ?? Promise.resolve();
    let release = (): void => undefined;
    const mine = new Promise<void>((done) => {
      release = done;
    });
    const tail = ahead.then(() => mine);
    this.doors.set(deviceId, tail);
    await ahead;
    return () => {
      release();
      if (this.doors.get(deviceId) === tail) {
        this.doors.delete(deviceId);
      }
    };
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
