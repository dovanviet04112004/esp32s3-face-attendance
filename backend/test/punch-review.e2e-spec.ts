import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import type { AttendanceRecord } from "../src/common/generated/attendance_record.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { AttendanceService } from "../src/modules/attendance/attendance.service.js";
import { hashPassword } from "../src/modules/auth/password.js";
import { dayAsDate, dayWindow, localDay } from "../src/modules/timesheet/local-day.js";
import { TimesheetService } from "../src/modules/timesheet/timesheet.service.js";

const WORKER = "E2EPV01";
const STRANGER = "E2EPV02";
const GONE = "E2EPV03";
const WAITING = "E2EPV04";
const REVIEWER = "E2EPV05";
const BOSS = "E2EPV06";
const CODES = [WORKER, STRANGER, GONE, WAITING, REVIEWER, BOSS];
const MAIL = (code: string) => `${code.toLowerCase()}@kiosk.local`;
const PASSWORD = "kiosk-e2e-password";
const DEVICE = "e2e-pv-01";
const ENTITY = "E2E-PV";
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const REBUILD_POLLS = 40;
const REBUILD_POLL_MS = 250;

describe("punch review (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let attendance: AttendanceService;
  let timesheet: TimesheetService;
  let zone = "";
  let admin = "";
  let reviewer = "";
  let boss = "";
  let entityId = "";
  let closedDay = "";
  let lateDay = "";
  let revokedAt = new Date();
  let local = 0;
  const idOf = new Map<string, number>();

  function punch(code: string, ts: number): AttendanceRecord {
    local += 1;
    return {
      deviceId: DEVICE,
      localId: String(9_870_000 + local),
      employeeId: idOf.get(code) as number,
      ts,
      direction: "IN",
      matchScore: 0.9,
      livenessScore: 0.9,
      modelVersion: 1,
    };
  }

  async function heldRow(code: string, day: string) {
    const { from, to } = dayWindow(day, zone);
    return db.attendanceRecord.findFirstOrThrow({
      where: { deviceId: DEVICE, employeeId: idOf.get(code), ts: { gte: from, lt: to } },
    });
  }

  function dayRow(code: string, day: string) {
    return db.attendanceDay.findFirst({ where: { employeeId: idOf.get(code), date: dayAsDate(day) } });
  }

  async function signIn(email: string): Promise<string> {
    const res = await request(http).post("/auth/login").send({ email, password: PASSWORD });
    assert.equal(res.status, 200, `${email} could not sign in`);
    return res.body.accessToken;
  }

  function decide(token: string, id: bigint, body: object) {
    return request(http).post(`/attendance/held/${id}/decide`).set("Authorization", `Bearer ${token}`).send(body);
  }

  async function sweep(): Promise<void> {
    await db.attendanceRecord.deleteMany({ where: { deviceId: DEVICE } });
    await db.device.deleteMany({ where: { id: DEVICE } });
    await db.user.deleteMany({ where: { email: { in: CODES.map(MAIL) } } });
    await db.employee.deleteMany({ where: { code: { in: CODES } } });
    await db.payrollPeriod.deleteMany({ where: { legalEntity: { code: ENTITY } } });
    await db.legalEntity.deleteMany({ where: { code: ENTITY } });
  }

  before(async () => {
    const env = validateEnv();
    zone = env.APP_TIMEZONE;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    http = app.getHttpServer();
    db = app.get(PrismaService);
    attendance = app.get(AttendanceService);
    timesheet = app.get(TimesheetService);
    await sweep();

    const signedIn = await request(http)
      .post("/auth/login")
      .send({ email: "admin@kiosk.local", password: env.SEED_ADMIN_PASSWORD ?? "" });
    assert.equal(signedIn.status, 200, "admin could not sign in");
    admin = signedIn.body.accessToken;

    entityId = (await db.legalEntity.create({ data: { code: ENTITY, name: "Pháp nhân duyệt lượt" } })).id;
    await db.device.create({ data: { id: DEVICE, status: "APPROVED" } });
    const roles: Record<string, "EMPLOYEE" | "HR" | "MANAGER"> = { [REVIEWER]: "HR", [BOSS]: "MANAGER" };
    for (const code of CODES) {
      const made = await db.employee.create({
        data: {
          code,
          fullName: `Duyệt lượt ${code}`,
          active: true,
          ...(code === WORKER ? { legalEntityId: entityId } : {}),
          login: { create: { email: MAIL(code), passwordHash: await hashPassword(PASSWORD), role: roles[code] ?? "EMPLOYEE" } },
        },
      });
      idOf.set(code, made.id);
    }
    revokedAt = new Date(Date.now() - 2 * HOUR_MS);
    await db.deviceEnrollment.createMany({
      data: [
        { deviceId: DEVICE, employeeId: idOf.get(WORKER) as number, state: "ENROLLED" },
        { deviceId: DEVICE, employeeId: idOf.get(GONE) as number, state: "REVOKED", revokedAt },
        { deviceId: DEVICE, employeeId: idOf.get(WAITING) as number, state: "ASSIGNED" },
        { deviceId: DEVICE, employeeId: idOf.get(REVIEWER) as number, state: "ENROLLED" },
      ],
    });

    // Three days back is inside the review window, so only the lock can hold its punch.
    closedDay = localDay(new Date(Date.now() - 3 * DAY_MS), zone);
    lateDay = localDay(new Date(Date.now() - 10 * DAY_MS), zone);
    const [year, month] = closedDay.split("-").map(Number);
    await db.payrollPeriod.create({
      data: {
        legalEntityId: entityId,
        year,
        month,
        state: "LOCKED",
        startDate: new Date(Date.UTC(year, month - 1, 1)),
        endDate: new Date(Date.UTC(year, month, 0)),
      },
    });
    reviewer = await signIn(MAIL(REVIEWER));
    boss = await signIn(MAIL(BOSS));
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("drops a punch for someone the door does not hold, and keeps one taken ahead of a revoke", async () => {
    const now = Date.now();
    assert.equal(await attendance.record(punch(STRANGER, now), new Date()), "not-on-device");
    assert.equal(await attendance.record(punch(GONE, now), new Date()), "not-on-device");
    assert.equal(await attendance.record(punch(GONE, revokedAt.getTime() - HOUR_MS), new Date()), "stored");
    assert.equal(await attendance.record(punch(WAITING, now), new Date()), "stored", "a door that captured offline lost its punch");
    assert.equal(await db.attendanceRecord.count({ where: { employeeId: idOf.get(STRANGER) } }), 0, "a stranger's punch was written");
    assert.equal(await db.attendanceRecord.count({ where: { employeeId: idOf.get(GONE) } }), 1);
  });

  it("holds a punch a week behind its receipt and one for a locked period, and neither lands in a day", async () => {
    const late = dayWindow(lateDay, zone).from.getTime() + 8 * HOUR_MS;
    assert.equal(await attendance.record(punch(WORKER, late), new Date()), "held");
    assert.equal(await attendance.record(punch(WORKER, dayWindow(closedDay, zone).from.getTime() + 8 * HOUR_MS), new Date()), "held");
    assert.equal(await attendance.record(punch(REVIEWER, late), new Date()), "held");

    const lateRow = await heldRow(WORKER, lateDay);
    const closedRow = await heldRow(WORKER, closedDay);
    assert.deepEqual([lateRow.hold, lateRow.review], ["LATE", "PENDING"]);
    assert.deepEqual([closedRow.hold, closedRow.review], ["CLOSED_PERIOD", "PENDING"]);

    for (const day of [lateDay, closedDay]) {
      await timesheet.build(day, idOf.get(WORKER));
      assert.equal((await dayRow(WORKER, day))?.punchCount, 0, `a held punch counted into ${day}`);
    }
  });

  it("lists the held punches for HR, never the reviewer's own, and counts them on the badge", async () => {
    const listed = await request(http)
      .get(`/attendance/held?search=${WORKER}`)
      .set("Authorization", `Bearer ${reviewer}`);
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.deepEqual(
      listed.body.rows.map((row: { hold: string }) => row.hold).sort(),
      ["CLOSED_PERIOD", "LATE"],
    );
    assert.equal(listed.body.rows[0].employee.code, WORKER);
    const own = await request(http)
      .get(`/attendance/held?search=${REVIEWER}`)
      .set("Authorization", `Bearer ${reviewer}`);
    assert.equal(own.body.rows.length, 0, "the reviewer's own held punch reached their queue");
    const seen = await request(http).get(`/attendance/held?search=${REVIEWER}`).set("Authorization", `Bearer ${admin}`);
    assert.equal(seen.body.rows.length, 1, "the admin did not see the reviewer's held punch");

    const counted = await request(http).get("/requests/inbox/counts").set("Authorization", `Bearer ${reviewer}`);
    assert.ok(counted.body.punches >= 2, JSON.stringify(counted.body));
    const managed = await request(http).get("/requests/inbox/counts").set("Authorization", `Bearer ${boss}`);
    assert.equal(managed.body.punches, 0, "a manager was counted held punches");
    const flagged = await request(http)
      .get(`/attendance/counts?employeeId=${idOf.get(WORKER)}&from=${dayWindow(lateDay, zone).from.toISOString()}`)
      .set("Authorization", `Bearer ${admin}`);
    assert.equal(flagged.body.held, 2, JSON.stringify(flagged.body));
  });

  it("refuses a turn-down with no reason, a manager's decision, and a reviewer's own punch", async () => {
    const lateRow = await heldRow(WORKER, lateDay);
    const bare = await decide(reviewer, lateRow.id, { approve: false });
    assert.deepEqual([bare.status, bare.body.message], [400, "DECISION_NOTE_REQUIRED"]);
    const managed = await decide(boss, lateRow.id, { approve: true });
    assert.deepEqual([managed.status, managed.body.message], [403, "HR_ONLY"]);
    const own = await heldRow(REVIEWER, lateDay);
    const mine = await decide(reviewer, own.id, { approve: true });
    assert.deepEqual([mine.status, mine.body.message], [403, "SELF_DECISION"]);
    const never = await db.attendanceRecord.findFirstOrThrow({ where: { employeeId: idOf.get(WAITING) } });
    const plain = await decide(reviewer, never.id, { approve: true });
    assert.deepEqual([plain.status, plain.body.message], [404, "PUNCH_NOT_FOUND"]);
  });

  it("lets an accepted punch build its day, and refuses a second decision", async () => {
    const closedRow = await heldRow(WORKER, closedDay);
    const accepted = await decide(reviewer, closedRow.id, { approve: true });
    assert.equal(accepted.status, 201, JSON.stringify(accepted.body));
    assert.equal(accepted.body.review, "ACCEPTED");
    let row = await dayRow(WORKER, closedDay);
    for (let polls = 0; row?.punchCount !== 1 && polls < REBUILD_POLLS; polls += 1) {
      await new Promise((resolve) => setTimeout(resolve, REBUILD_POLL_MS));
      row = await dayRow(WORKER, closedDay);
    }
    assert.equal(row?.punchCount, 1, "the accepted punch never reached its day");
    const again = await decide(reviewer, closedRow.id, { approve: false, note: "nhầm" });
    assert.deepEqual([again.status, again.body.message], [409, "PUNCH_ALREADY_DECIDED"]);
    const trail = await db.auditLog.findFirst({ where: { subjectType: "punch", subjectId: String(closedRow.id) } });
    assert.equal(trail?.action, "punch.accept", "the decision left no audit line");
  });

  it("turns a held punch down for good, and a batch reports what it passed over", async () => {
    const lateRow = await heldRow(WORKER, lateDay);
    const closedRow = await heldRow(WORKER, closedDay);
    const batch = await request(http)
      .post("/attendance/held/decide-many")
      .set("Authorization", `Bearer ${reviewer}`)
      .send({ ids: [String(lateRow.id), String(closedRow.id)], approve: false, note: "Máy không ở cửa này hôm ấy" });
    assert.equal(batch.status, 201, JSON.stringify(batch.body));
    assert.deepEqual(batch.body.decided, [String(lateRow.id)]);
    assert.deepEqual(batch.body.skipped, [{ id: String(closedRow.id), code: "PUNCH_ALREADY_DECIDED" }]);
    const refused = await db.attendanceRecord.findUniqueOrThrow({ where: { id: lateRow.id } });
    assert.deepEqual([refused.review, refused.reviewNote], ["REJECTED", "Máy không ở cửa này hôm ấy"]);
    await timesheet.build(lateDay, idOf.get(WORKER));
    assert.equal((await dayRow(WORKER, lateDay))?.punchCount, 0, "a turned-down punch counted");
  });
});
