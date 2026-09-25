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
import { LeaveYearService } from "../src/modules/leave/leave-year.service.js";
import { paidLeaveType } from "./fixtures.js";
import { clearDeskNotices } from "./teardown.js";

// Alone: opening a year writes a row for every working person, and a leave type
// declared here would be handed to anybody another suite hires meanwhile.
const PASSWORD = "kiosk-e2e-password";
const CODE = "NV9302";
const EMAIL = "nv9302@kiosk.local";
const HIRED = "2020-07-01";
const ENTITLED = 12;
const CARRY_TYPE = "E2E-LY-CARRY";
const LATE_TYPE = "E2E-LY-LATE";
const UNPAID_TYPE = "E2E-LY-UNPAID";
const MY_TYPES = [CARRY_TYPE, LATE_TYPE, UNPAID_TYPE];
const CARRY_CAP = 5;
const LATE_DAYS = 6;
const CLOSED_YEAR = 2044;
const OPENED_YEAR = 2045;

interface Held {
  entitled: number;
  carriedOver: number;
  carriedOut: number;
  taken: number;
  pending: number;
  closed: boolean;
}

describe("leave years (e2e, alone)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let years: LeaveYearService;
  let token = "";
  let adminToken = "";
  let employeeId = 0;
  let annualId = "";

  async function sweep(): Promise<void> {
    await clearDeskNotices(db, [CODE]);
    await db.user.deleteMany({ where: { email: EMAIL } });
    await db.employee.deleteMany({ where: { code: CODE } });
    await db.leaveBalance.deleteMany({ where: { leaveType: { code: { in: MY_TYPES } } } });
    await db.leaveType.deleteMany({ where: { code: { in: MY_TYPES } } });
  }

  function fileLeave(leaveTypeId: string, from: string, to: string): request.Test {
    return request(http)
      .post("/requests")
      .set("Authorization", `Bearer ${token}`)
      .send({ kind: "LEAVE", leaveTypeId, fromDate: from, toDate: to, reason: "e2e" });
  }

  async function held(year: number, leaveTypeId: string): Promise<Held | null> {
    const row = await db.leaveBalance.findUnique({
      where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year } },
    });
    if (!row) {
      return null;
    }
    return {
      entitled: Number(row.entitled),
      carriedOver: Number(row.carriedOver),
      carriedOut: Number(row.carriedOut),
      taken: Number(row.taken),
      pending: Number(row.pending),
      closed: row.closedAt !== null,
    };
  }

  before(async () => {
    const env = validateEnv();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    http = app.getHttpServer();
    db = app.get(PrismaService);
    years = app.get(LeaveYearService);
    await sweep();

    const asAdmin = await request(http)
      .post("/auth/login")
      .send({ email: "admin@kiosk.local", password: env.SEED_ADMIN_PASSWORD ?? "" });
    assert.equal(asAdmin.status, 200, "admin could not sign in");
    adminToken = asAdmin.body.accessToken;
    annualId = (await paidLeaveType(db)).id;

    const template = await db.employee.findFirstOrThrow({ where: { active: true } });
    const made = await db.employee.create({
      data: {
        code: CODE,
        fullName: "Thử năm phép",
        active: true,
        hireDate: new Date(HIRED),
        departmentId: template.departmentId,
        legalEntityId: template.legalEntityId,
      },
    });
    employeeId = made.id;
    await db.user.create({
      data: { email: EMAIL, passwordHash: await hashPassword(PASSWORD), role: "EMPLOYEE", employeeId },
    });
    const asMe = await request(http).post("/auth/login").send({ email: EMAIL, password: PASSWORD });
    assert.equal(asMe.status, 200, "the employee account could not sign in");
    token = asMe.body.accessToken;
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("opens a row on demand for a type declared after the hire, prorated only in the hire year", async () => {
    const late = await db.leaveType.create({ data: { code: LATE_TYPE, name: "Loại khai muộn", daysPerYear: LATE_DAYS } });
    const now = await fileLeave(late.id, "2036-10-06", "2036-10-06");
    assert.equal(now.status, 201, JSON.stringify(now.body));
    assert.equal((await held(2036, late.id))?.entitled, LATE_DAYS);
    const then = await fileLeave(late.id, "2020-10-05", "2020-10-05");
    assert.equal(then.status, 201, JSON.stringify(then.body));
    // 184 of 366 days left from 1 July 2020, rounded to the half day.
    assert.equal((await held(2020, late.id))?.entitled, 3);
  });

  it("files unpaid leave with no balance to draw on, and keeps it out of the balances", async () => {
    const unpaid = await db.leaveType.create({
      data: { code: UNPAID_TYPE, name: "Không lương thử", paid: false, daysPerYear: 0 },
    });
    const query = new URLSearchParams({ fromDate: "2036-11-03", toDate: "2036-11-07", leaveTypeId: unpaid.id });
    const asked = await request(http).get(`/leave-days?${query.toString()}`).set("Authorization", `Bearer ${token}`);
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    assert.equal(asked.body.limited, false);
    assert.equal(asked.body.parts[0]?.left, null);
    const filed = await fileLeave(unpaid.id, "2036-11-03", "2036-11-07");
    assert.equal(filed.status, 201, JSON.stringify(filed.body));
    assert.equal((await held(2036, unpaid.id))?.pending, 5);
    const shown = await request(http).get("/leave-balances?asOf=2036-11-01").set("Authorization", `Bearer ${token}`);
    assert.ok(
      !(shown.body as { leaveTypeId: string }[]).some((one) => one.leaveTypeId === unpaid.id),
      "an unpaid type shows a balance",
    );
    const inbox = await request(http)
      .get(`/requests/inbox?search=${CODE}&from=2036-11-03&to=2036-11-07`)
      .set("Authorization", `Bearer ${adminToken}`);
    const row = (inbox.body.rows as { id: string; balanceAfter: number | null }[]).find((one) => one.id === filed.body.id);
    assert.ok(row, "the desk's inbox does not hold the request");
    assert.equal(row.balanceAfter, null, "the inbox gave an unpaid request a balance");
    const decided = await request(http)
      .post(`/requests/${filed.body.id}/decide`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ approve: true });
    assert.equal(decided.status, 201);
    assert.equal((await held(2036, unpaid.id))?.taken, 5);
  });

  it("opens a new year with capped carry-over, completing a row filed into ahead, and a second run changes nothing", async () => {
    const carry = await db.leaveType.create({
      data: { code: CARRY_TYPE, name: "Phép chuyển thử", daysPerYear: ENTITLED, carryOverMax: CARRY_CAP },
    });
    await db.leaveBalance.create({
      data: { employeeId, leaveTypeId: carry.id, year: CLOSED_YEAR, entitled: ENTITLED, taken: 3, pending: 1 },
    });
    const ahead = await fileLeave(carry.id, "2045-02-06", "2045-02-06");
    assert.equal(ahead.status, 201, JSON.stringify(ahead.body));
    assert.equal((await held(OPENED_YEAR, carry.id))?.carriedOver, 0, "a year not begun carried over early");

    const first = await years.open(OPENED_YEAR);
    assert.equal(first.carried, 1);
    const closed = await held(CLOSED_YEAR, carry.id);
    const opened = await held(OPENED_YEAR, carry.id);
    assert.deepEqual(
      { carriedOut: closed?.carriedOut, closed: closed?.closed },
      { carriedOut: CARRY_CAP, closed: true },
      "eight days free under a cap of five should carry five",
    );
    assert.deepEqual(
      { entitled: opened?.entitled, carriedOver: opened?.carriedOver, pending: opened?.pending },
      { entitled: ENTITLED, carriedOver: CARRY_CAP, pending: 1 },
    );
    assert.equal((await held(OPENED_YEAR, annualId))?.entitled, ENTITLED, "a working person got no row of another type");

    const again = await years.open(OPENED_YEAR);
    assert.deepEqual([again.created, again.carried], [0, 0]);
    assert.deepEqual(await held(CLOSED_YEAR, carry.id), closed);
    assert.deepEqual(await held(OPENED_YEAR, carry.id), opened);
  });

  it("does not spend in a closed year the days it carried out", async () => {
    const carry = await db.leaveType.findUniqueOrThrow({ where: { code: CARRY_TYPE } });
    // Twelve entitled, three taken, one waiting, five carried out: three are left in 2044.
    const four = await fileLeave(carry.id, "2044-05-02", "2044-05-05");
    assert.equal(four.status, 409);
    assert.equal(four.body.message, "LEAVE_BALANCE_SHORT");
    const three = await fileLeave(carry.id, "2044-05-02", "2044-05-04");
    assert.equal(three.status, 201, JSON.stringify(three.body));
  });
});
