import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { hashPassword } from "../src/modules/auth/password.js";
import { MAX_DAY_ROWS } from "../src/modules/timesheet/dto/timesheet.dto.js";
import { TimesheetService } from "../src/modules/timesheet/timesheet.service.js";
import { paidLeaveType } from "./fixtures.js";
import { clearDeskNotices } from "./teardown.js";

// A Monday the seed never touches, inside the partition range, with no holiday
// on it: building it writes a fresh day for everyone and disturbs no history.
const DAY = "2026-03-16";

// One person per scenario, because an exclusion constraint refuses a second
// leave request overlapping the first.
const AHEAD = "NV9101";
const BEHIND = "NV9102";
const MEASURED = "NV9103";
const HALF = "NV9104";
const FIXED = "NV9105";
const TRIP = "NV9106";
const REMOTE = "NV9107";
const MADE_CODES = [AHEAD, BEHIND, MEASURED, HALF, FIXED, TRIP, REMOTE];

// Made here rather than by provisioning, which opens a login for everyone
// waiting and would race the leave suite for the same people.
const FILER_EMAIL = "nv9105@kiosk.local";
const FILER_PASSWORD = "kiosk-e2e-password";

describe("timesheet leave (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let timesheet: TimesheetService;
  let adminToken = "";
  let filerToken = "";
  let leaveTypeId = "";
  const idOf = new Map<string, number>();

  const date = new Date(`${DAY}T00:00:00.000Z`);

  async function sweep(): Promise<void> {
    await clearDeskNotices(db, MADE_CODES);
    await db.attendanceDay.deleteMany({ where: { date } });
    await db.user.deleteMany({ where: { email: FILER_EMAIL } });
    await db.employee.deleteMany({ where: { code: { in: MADE_CODES } } });
  }

  async function rowOf(code: string) {
    return db.attendanceDay.findFirst({ where: { employeeId: idOf.get(code), date } });
  }

  async function stateOf(code: string): Promise<string> {
    const row = await db.attendanceDay.findFirst({
      where: { employeeId: idOf.get(code), date },
    });
    return row?.state ?? "MISSING";
  }

  async function approveLeave(code: string, halfDay: boolean): Promise<number> {
    const employeeId = idOf.get(code) as number;
    const filed = await db.request.create({
      data: {
        employeeId,
        kind: "LEAVE",
        state: "PENDING",
        leaveTypeId,
        fromDate: date,
        toDate: date,
        halfDay,
        days: halfDay ? 0.5 : 1,
        reason: "e2e",
      },
    });
    await db.leaveBalance.update({
      where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year: 2026 } },
      data: { pending: { increment: halfDay ? 0.5 : 1 } },
    });
    const res = await request(http)
      .post(`/requests/${filed.id}/decide`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ approve: true });
    return res.status;
  }

  before(async () => {
    const env = validateEnv();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    http = app.getHttpServer();
    db = app.get(PrismaService);
    timesheet = app.get(TimesheetService);
    await sweep();

    const signedIn = await request(http)
      .post("/auth/login")
      .send({ email: "admin@kiosk.local", password: env.SEED_ADMIN_PASSWORD ?? "" });
    assert.equal(signedIn.status, 200, "admin could not sign in");
    adminToken = signedIn.body.accessToken;

    const type = await paidLeaveType(db);
    leaveTypeId = type.id;

    const template = await db.employee.findFirstOrThrow({ where: { active: true } });
    for (const code of MADE_CODES) {
      const made = await db.employee.create({
        data: {
          code,
          fullName: `Thử nghỉ phép ${code}`,
          active: true,
          departmentId: template.departmentId,
          legalEntityId: template.legalEntityId,
        },
      });
      idOf.set(code, made.id);
      await db.leaveBalance.create({
        data: { employeeId: made.id, leaveTypeId, year: 2026, entitled: 12 },
      });
    }

    await db.user.create({
      data: {
        email: FILER_EMAIL,
        passwordHash: await hashPassword(FILER_PASSWORD),
        role: "EMPLOYEE",
        employeeId: idOf.get(FIXED) as number,
      },
    });
    const asFiler = await request(http)
      .post("/auth/login")
      .send({ email: FILER_EMAIL, password: FILER_PASSWORD });
    assert.equal(asFiler.status, 200, "the filing account could not sign in");
    filerToken = asFiler.body.accessToken;
  });

  async function fileFix(from: string, to: string, minutes: number): Promise<request.Response> {
    return request(http)
      .post("/requests")
      .set("Authorization", `Bearer ${filerToken}`)
      .send({ kind: "ATTENDANCE_FIX", fromDate: from, toDate: to, minutes, reason: "quên quẹt" });
  }

  after(async () => {
    await sweep();
    await app.close();
  });

  it("builds an approved leave day as LEAVE and leaves everyone else absent", async () => {
    assert.equal(await approveLeave(AHEAD, false), 201);
    await timesheet.build(DAY);
    assert.equal(await stateOf(AHEAD), "LEAVE");
    assert.equal(await stateOf(BEHIND), "ABSENT");
  });

  it("counts that day as leave and not as absence in the summary", async () => {
    const res = await request(http)
      .get(`/timesheet/summary?from=${DAY}&to=${DAY}&employeeId=${idOf.get(AHEAD)}`)
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(res.status, 200);
    const { rows } = res.body as {
      rows: { employeeId: number; leaveDays: number; absentDays: number }[];
    };
    const row = rows.find((one) => one.employeeId === idOf.get(AHEAD));
    assert.ok(row, "the person on leave is missing from the summary");
    assert.equal(row.leaveDays, 1);
    assert.equal(row.absentDays, 0);
  });

  it("turns a day already built absent into leave when the approval lands later", async () => {
    assert.equal(await stateOf(BEHIND), "ABSENT");
    assert.equal(await approveLeave(BEHIND, false), 201);
    assert.equal(await stateOf(BEHIND), "LEAVE");
  });

  it("keeps a day the device measured", async () => {
    await db.attendanceDay.updateMany({
      where: { employeeId: idOf.get(MEASURED), date },
      data: { state: "WORKED", punchCount: 2, workedMinutes: 480 },
    });
    assert.equal(await approveLeave(MEASURED, false), 201);
    assert.equal(await stateOf(MEASURED), "WORKED");
  });

  it("does not turn a half day into a whole day of leave", async () => {
    assert.equal(await approveLeave(HALF, true), 201);
    assert.equal(await stateOf(HALF), "ABSENT");
  });

  it("does not count a registered trip as an absence when the build runs", async () => {
    await db.request.create({
      data: {
        employeeId: idOf.get(TRIP) as number,
        kind: "BUSINESS_TRIP",
        state: "APPROVED",
        fromDate: date,
        toDate: date,
        days: 1,
        reason: "e2e",
      },
    });
    await timesheet.build(DAY);
    const row = await rowOf(TRIP);
    assert.equal(row?.state, "WORKED");
    assert.equal(row?.punchCount, 0, "the kiosk saw nobody and must not claim it did");
  });

  it("clears the absence when remote work is approved after the build", async () => {
    assert.equal(await stateOf(REMOTE), "ABSENT");
    const filed = await db.request.create({
      data: {
        employeeId: idOf.get(REMOTE) as number,
        kind: "REMOTE_WORK",
        state: "PENDING",
        fromDate: date,
        toDate: date,
        days: 1,
        reason: "e2e",
      },
    });
    const decided = await request(http)
      .post(`/requests/${filed.id}/decide`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ approve: true });
    assert.equal(decided.status, 201);
    assert.equal(await stateOf(REMOTE), "WORKED");
  });

  it("refuses a correction that reaches across more than one day", async () => {
    const res = await fileFix(DAY, "2026-03-17", 480);
    assert.equal(res.status, 400);
    assert.equal(res.body.message, "FIX_ONE_DAY_ONLY");
  });

  it("refuses a correction for a day that has not finished", async () => {
    const running = timesheet.today();
    const res = await fileFix(running, running, 480);
    assert.equal(res.status, 400);
    assert.equal(res.body.message, "FIX_DAY_NOT_FINISHED");
  });

  it("writes an approved correction onto the day and keeps the measured figure", async () => {
    const filed = await fileFix(DAY, DAY, 480);
    assert.equal(filed.status, 201);
    const decided = await request(http)
      .post(`/requests/${filed.body.id}/decide`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ approve: true });
    assert.equal(decided.status, 201);

    const row = await rowOf(FIXED);
    assert.ok(row);
    assert.equal(row.state, "WORKED");
    assert.equal(row.workedMinutes, 480);
    assert.equal(row.measuredMinutes, 0, "what the device saw has to survive");
    assert.equal(row.adjustReason, "quên quẹt");
    assert.ok(row.adjustedById, "a correction has to name who made it");
  });

  it("leaves a corrected day alone when the day is built again", async () => {
    await timesheet.build(DAY);
    const row = await rowOf(FIXED);
    assert.equal(row?.state, "WORKED");
    assert.equal(row?.workedMinutes, 480);
  });

  it("sums the summary over everybody the filter reaches, not one page of it", async () => {
    const read = async (path: string) =>
      (await request(http).get(`/timesheet/${path}?from=${DAY}&to=${DAY}&take=200`).set("Authorization", `Bearer ${adminToken}`)).body;
    const totals = await read("totals");
    const page = await read("summary");
    type Row = { workedDays: number; leaveDays: number; absentDays: number; adjustedDays: number };
    const rows = page.rows as Row[];
    assert.equal(totals.people, page.total);
    if (page.next === null) {
      for (const field of ["workedDays", "leaveDays", "absentDays", "adjustedDays"] as const) {
        assert.equal(totals[field], rows.reduce((sum, one) => sum + one[field], 0), `${field} sums differently`);
      }
    }
    assert.ok(totals.leaveDays >= 2, "the two leave days this suite built are missing");
  });

  it("says where a queued build stands, and that an unknown job is gone", async () => {
    const queued = await request(http)
      .post("/timesheet/build")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ from: DAY, to: DAY });
    assert.equal(queued.status, 201);
    const state = await request(http)
      .get(`/timesheet/build/${queued.body.jobId}`)
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(state.status, 200);
    assert.ok(["waiting", "active", "completed", "failed"].includes(state.body.state), state.body.state);
    const missing = await request(http)
      .get("/timesheet/build/no-such-job")
      .set("Authorization", `Bearer ${adminToken}`);
    assert.deepEqual(missing.body, { state: "gone" });
  });
});

const RANGE_DEPARTMENT = "E2ETR-D";
const RANGE_CHILD = "E2ETR-DC";
const CHILD_PERSON = "E2ETRC01";
const RANGE_PEOPLE = Array.from({ length: 20 }, (unused, at) => `E2ETR${String(at + 1).padStart(2, "0")}`);
// Exactly the cap across the department, so one more day for one person tips it over.
const RANGE_DAYS = MAX_DAY_ROWS / RANGE_PEOPLE.length;

function rangeDay(offset: number): string {
  return new Date(Date.UTC(2027, 0, 1 + offset)).toISOString().slice(0, 10);
}

describe("timesheet day list (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let token = "";
  let departmentId = "";
  const ids: number[] = [];

  async function sweep(): Promise<void> {
    await db.employee.deleteMany({ where: { code: { in: [...RANGE_PEOPLE, CHILD_PERSON] } } });
    await db.department.deleteMany({ where: { code: RANGE_CHILD } });
    await db.department.deleteMany({ where: { code: RANGE_DEPARTMENT } });
  }

  function days(query: string): Promise<request.Response> {
    return request(http).get(`/timesheet?${query}`).set("Authorization", `Bearer ${token}`);
  }

  before(async () => {
    const env = validateEnv();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    http = app.getHttpServer();
    db = app.get(PrismaService);
    await sweep();

    const signedIn = await request(http)
      .post("/auth/login")
      .send({ email: "admin@kiosk.local", password: env.SEED_ADMIN_PASSWORD ?? "" });
    assert.equal(signedIn.status, 200, "admin could not sign in");
    token = signedIn.body.accessToken;

    const template = await db.employee.findFirstOrThrow({ where: { active: true, legalEntityId: { not: null } } });
    const department = await db.department.create({
      data: { code: RANGE_DEPARTMENT, name: "Phòng thử khoảng ngày", legalEntityId: template.legalEntityId as string },
    });
    departmentId = department.id;
    for (const code of RANGE_PEOPLE) {
      // Closed records, so no build from another suite adds a day to what this one counts.
      const made = await db.employee.create({
        data: { code, fullName: `Thử khoảng ${code}`, departmentId, active: false, leaveDate: new Date("2026-01-31") },
      });
      ids.push(made.id);
      await db.attendanceDay.createMany({
        data: Array.from({ length: RANGE_DAYS }, (unused, at) => ({ employeeId: made.id, date: new Date(rangeDay(at)) })),
      });
    }
    await db.attendanceDay.create({ data: { employeeId: ids[0] as number, date: new Date(rangeDay(RANGE_DAYS)) } });
    // A day outside the capped range, so the branch filter is tested without moving the cap.
    const child = await db.department.create({
      data: { code: RANGE_CHILD, name: "Tổ con thử khoảng", parentId: departmentId, legalEntityId: template.legalEntityId as string },
    });
    const below = await db.employee.create({
      data: { code: CHILD_PERSON, fullName: "Thử nhánh con", departmentId: child.id, active: false, leaveDate: new Date("2026-01-31") },
    });
    await db.attendanceDay.create({ data: { employeeId: below.id, date: new Date(rangeDay(RANGE_DAYS + 5)) } });
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("answers a range holding exactly the cap in full", async () => {
    const res = await days(`from=${rangeDay(0)}&to=${rangeDay(RANGE_DAYS - 1)}&departmentId=${departmentId}`);
    assert.equal(res.status, 200, JSON.stringify(res.body).slice(0, 200));
    assert.equal((res.body as unknown[]).length, MAX_DAY_ROWS);
  });

  it("refuses a range past the cap with a code rather than cutting it short", async () => {
    const res = await days(`from=${rangeDay(0)}&to=${rangeDay(RANGE_DAYS)}&departmentId=${departmentId}`);
    assert.equal(res.status, 400, "a range past the cap came back cut short");
    assert.equal(res.body.message, "RANGE_TOO_LARGE");

    const narrowed = await days(`from=${rangeDay(0)}&to=${rangeDay(RANGE_DAYS)}&employeeId=${ids[0] as number}`);
    assert.equal(narrowed.status, 200);
    assert.equal((narrowed.body as unknown[]).length, RANGE_DAYS + 1, "narrowing to one person lost some of their days");
  });

  it("reads a department filter as the whole branch under it", async () => {
    const res = await days(`from=${rangeDay(RANGE_DAYS + 5)}&to=${rangeDay(RANGE_DAYS + 5)}&departmentId=${departmentId}`);
    assert.equal(res.status, 200);
    assert.equal((res.body as unknown[]).length, 1, "a day in a child department was left out of its parent's list");
  });

  it("refuses the paging it never applied", async () => {
    for (const paging of ["take=10", "skip=10", "cursor=abc"]) {
      const res = await days(`from=${rangeDay(0)}&to=${rangeDay(0)}&employeeId=${ids[0] as number}&${paging}`);
      assert.equal(res.status, 400, `${paging} was taken and ignored`);
      assert.equal(res.body.message, "VALIDATION_FAILED");
    }
  });
});
