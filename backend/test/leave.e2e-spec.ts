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
import { paidLeaveType } from "./fixtures.js";
import { clearDeskNotices } from "./teardown.js";

const PASSWORD = "kiosk-e2e-password";
const CODE = "NV9301";
const EMAIL = "nv9301@kiosk.local";
const ENTITLED = 12;
const HIRED = "2020-07-01";
const OWN_ENTITY = "E2E-LV-OWN";
const OTHER_ENTITY = "E2E-LV-OTHER";

// Far enough ahead that nothing the seed filed can overlap it.
const BOOKED_FROM = "2026-11-10";
const BOOKED_TO = "2026-11-12";
const BOOKED_DAYS = 3;
const BEFORE_IT = "2026-11-01";
const AFTER_IT = "2026-11-20";

// No other suite files, declares holidays or opens balances in these years.
const FRIDAY = "2036-03-07";
const MONDAY = "2036-03-10";
const SUNDAY = "2036-03-09";
const WEEK_FROM = "2036-06-09";
const WEEK_TO = "2036-06-13";
const OWN_HOLIDAY = "2036-06-11";
const OTHER_HOLIDAY = "2036-06-12";

interface Balance {
  leaveTypeId: string;
  code: string;
  year: number;
  entitled: number;
  remaining: number;
  bookedAfter: number;
}

interface Charge {
  days: number;
  limited: boolean;
  parts: { year: number; days: number; left: number | null }[];
}

interface Held {
  entitled: number;
  carriedOver: number;
  carriedOut: number;
  taken: number;
  pending: number;
  closed: boolean;
}

describe("leave balance (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let token = "";
  let adminToken = "";
  let employeeId = 0;
  let leaveTypeId = "";
  const opened: string[] = [];

  async function sweep(): Promise<void> {
    await clearDeskNotices(db, [CODE]);
    await db.user.deleteMany({ where: { email: { in: [EMAIL, ...opened] } } });
    await db.employee.deleteMany({ where: { code: CODE } });
    await db.legalEntity.deleteMany({ where: { code: { in: [OWN_ENTITY, OTHER_ENTITY] } } });
  }

  async function balancesAt(asOf: string): Promise<Balance[]> {
    const res = await request(http)
      .get(`/leave-balances?asOf=${asOf}`)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    return res.body as Balance[];
  }

  function annual(rows: Balance[]): Balance {
    const row = rows.find((one) => one.leaveTypeId === leaveTypeId);
    assert.ok(row, "the annual leave row is missing");
    return row;
  }

  function fileLeave(from: string, to: string, extra: object = {}): request.Test {
    return request(http)
      .post("/requests")
      .set("Authorization", `Bearer ${token}`)
      .send({ kind: "LEAVE", leaveTypeId, fromDate: from, toDate: to, reason: "e2e", ...extra });
  }

  function charge(from: string, to: string, extra: Record<string, string> = {}): request.Test {
    const query = new URLSearchParams({ fromDate: from, toDate: to, leaveTypeId, ...extra });
    return request(http).get(`/leave-days?${query.toString()}`).set("Authorization", `Bearer ${token}`);
  }

  function asAdmin(path: string, body: object): request.Test {
    return request(http).post(path).set("Authorization", `Bearer ${adminToken}`).send(body);
  }

  async function held(year: number, type = leaveTypeId): Promise<Held | null> {
    const row = await db.leaveBalance.findUnique({
      where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId: type, year } },
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

  async function heldPair(first: number): Promise<[Held, Held]> {
    const [one, two] = await Promise.all([held(first), held(first + 1)]);
    assert.ok(one && two, "a year the request touches has no balance row");
    return [one, two];
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

    const asAdminLogin = await request(http)
      .post("/auth/login")
      .send({ email: "admin@kiosk.local", password: env.SEED_ADMIN_PASSWORD ?? "" });
    assert.equal(asAdminLogin.status, 200, "admin could not sign in");
    adminToken = asAdminLogin.body.accessToken;

    const type = await paidLeaveType(db);
    leaveTypeId = type.id;

    const own = await db.legalEntity.create({ data: { code: OWN_ENTITY, name: "Pháp nhân thử phép" } });
    const other = await db.legalEntity.create({ data: { code: OTHER_ENTITY, name: "Pháp nhân khác" } });
    await db.holiday.createMany({
      data: [
        { legalEntityId: own.id, date: new Date(OWN_HOLIDAY), name: "Lễ của pháp nhân mình" },
        { legalEntityId: other.id, date: new Date(OTHER_HOLIDAY), name: "Lễ của pháp nhân khác" },
      ],
    });

    const template = await db.employee.findFirstOrThrow({ where: { active: true } });
    const made = await db.employee.create({
      data: {
        code: CODE,
        fullName: "Thử số dư phép",
        active: true,
        hireDate: new Date(HIRED),
        departmentId: template.departmentId,
        legalEntityId: own.id,
      },
    });
    employeeId = made.id;
    await db.leaveBalance.create({
      data: { employeeId: made.id, leaveTypeId, year: 2026, entitled: ENTITLED },
    });

    // Made here rather than by provisioning: this suite needs an employee who
    // can sign in, not the invitation flow that password-setup covers.
    await db.user.create({
      data: {
        email: EMAIL,
        passwordHash: await hashPassword(PASSWORD),
        role: "EMPLOYEE",
        employeeId: made.id,
      },
    });
    opened.push(EMAIL);

    const asMe = await request(http)
      .post("/auth/login")
      .send({ email: EMAIL, password: PASSWORD });
    assert.equal(asMe.status, 200, "the employee account could not sign in");
    token = asMe.body.accessToken;
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("starts with the whole entitlement free", async () => {
    const row = annual(await balancesAt(BEFORE_IT));
    assert.equal(row.entitled, ENTITLED);
    assert.equal(row.remaining, ENTITLED);
    assert.equal(row.bookedAfter, 0);
  });

  it("takes the days out the moment a request is filed, before anyone answers", async () => {
    assert.equal((await fileLeave(BOOKED_FROM, BOOKED_TO)).status, 201);
    const row = annual(await balancesAt(BEFORE_IT));
    assert.equal(row.remaining, ENTITLED - BOOKED_DAYS);
  });

  it("says how much of what is left is already spoken for after the chosen day", async () => {
    assert.equal(annual(await balancesAt(BEFORE_IT)).bookedAfter, BOOKED_DAYS);
    assert.equal(annual(await balancesAt(AFTER_IT)).bookedAfter, 0);
  });

  it("answers for the year the chosen day falls in, not for today", async () => {
    const next = await balancesAt("2027-03-01");
    assert.equal(next.length, 0, "a year with no entitlement row has no balance to show");
  });

  it("refuses a request the figure it shows says there is no room for", async () => {
    const left = annual(await balancesAt(BEFORE_IT)).remaining;
    assert.equal(left, 9);
    // Tuesday 1 December to Monday 14 December holds ten working days.
    const res = await fileLeave("2026-12-01", "2026-12-14");
    assert.equal(res.status, 409);
    assert.equal(res.body.message, "LEAVE_BALANCE_SHORT");
  });

  it("charges a Friday to Monday as two working days", async () => {
    const asked = await charge(FRIDAY, MONDAY);
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    assert.equal((asked.body as Charge).days, 2);
    const filed = await fileLeave(FRIDAY, MONDAY);
    assert.equal(filed.status, 201, JSON.stringify(filed.body));
    assert.equal(Number(filed.body.days), 2);
    assert.equal((await held(2036))?.pending, 2, "the balance held calendar days");
  });

  it("skips a holiday of the person's own legal entity and not another entity's", async () => {
    const asked = await charge(WEEK_FROM, WEEK_TO);
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    assert.equal((asked.body as Charge).days, 4, "Monday to Friday less the own holiday is four");
  });

  it("counts every calendar day for a type flagged so, as maternity leave is", async () => {
    const made = await asAdmin("/leave-types", {
      code: "E2E_CALENDAR",
      name: "Thai sản (e2e)",
      daysPerYear: 180,
      calendarDays: true,
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    try {
      const ask = (from: string, to: string, extra: Record<string, string> = {}) =>
        request(http)
          .get(`/leave-days?${new URLSearchParams({ fromDate: from, toDate: to, leaveTypeId: made.body.id, ...extra }).toString()}`)
          .set("Authorization", `Bearer ${token}`);
      const span = await ask(FRIDAY, MONDAY);
      assert.equal(span.status, 200, JSON.stringify(span.body));
      assert.equal((span.body as Charge).days, 4, "a calendar-day type skipped the weekend");
      assert.equal(span.body.calendarDays, true);
      const half = await ask(SUNDAY, SUNDAY, { halfDay: "true" });
      assert.equal(half.status, 200, JSON.stringify(half.body));
      assert.equal((half.body as Charge).days, 0.5, "half a Sunday is a half day for a calendar-day type");
    } finally {
      await db.leaveType.delete({ where: { id: made.body.id as string } });
    }
  });

  it("refuses half a day on a Sunday", async () => {
    const res = await fileLeave(SUNDAY, SUNDAY, { halfDay: true, dayPart: "MORNING" });
    assert.equal(res.status, 400);
    assert.equal(res.body.message, "HALF_DAY_NOT_WORKING");
    const asked = await charge(SUNDAY, SUNDAY, { halfDay: "true" });
    assert.equal(asked.body.message, "HALF_DAY_NOT_WORKING", "the preview and the filing disagree");
  });

  it("refuses a range that holds no working day, and one reaching a third year", async () => {
    const weekend = await fileLeave("2036-06-14", "2036-06-15");
    assert.equal(weekend.status, 400);
    assert.equal(weekend.body.message, "LEAVE_NO_WORKING_DAY");
    const long = await fileLeave("2036-12-30", "2038-01-02");
    assert.equal(long.status, 400);
    assert.equal(long.body.message, "LEAVE_SPANS_YEARS");
  });

  it("previews a request across New Year as one part per year", async () => {
    const was = await held(2036);
    assert.ok(was, "the Friday to Monday filing left no 2036 row");
    const asked = await charge("2036-12-30", "2037-01-03");
    assert.equal(asked.status, 200, JSON.stringify(asked.body));
    const body = asked.body as Charge;
    assert.equal(body.days, 4);
    assert.deepEqual(
      body.parts.map((part) => [part.year, part.days]),
      [[2036, 2], [2037, 2]],
    );
    assert.equal(body.parts[0]?.left, was.entitled + was.carriedOver - was.taken - was.pending - 2);
    assert.equal(body.parts[1]?.left, ENTITLED - 2, "a year with no row yet is shown as it would open");
  });

  it("holds 30/12 to 3/1 on both years and approving takes both", async () => {
    const was2036 = await held(2036);
    const filed = await fileLeave("2036-12-30", "2037-01-03");
    assert.equal(filed.status, 201, JSON.stringify(filed.body));
    assert.equal(Number(filed.body.days), 4);
    assert.equal(Number(filed.body.nextYearDays), 2);
    const [one, two] = await heldPair(2036);
    assert.equal(one.pending - (was2036?.pending ?? 0), 2);
    assert.equal(two.pending, 2);
    assert.equal(two.entitled, ENTITLED, "the new year's row did not open on demand with a full year");

    const inbox = await request(http)
      .get(`/requests/inbox?search=${CODE}&kind=LEAVE&from=2036-12-30&to=2037-01-03`)
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(inbox.status, 200);
    const row = (inbox.body.rows as { id: string; balanceAfter: number; nextBalanceAfter: number }[]).find(
      (one) => one.id === filed.body.id,
    );
    assert.ok(row, "the desk's inbox does not hold the request");
    assert.equal(row.balanceAfter, one.entitled - one.taken - one.pending);
    assert.equal(row.nextBalanceAfter, ENTITLED - 2);

    const detail = await request(http).get(`/requests/${filed.body.id}`).set("Authorization", `Bearer ${adminToken}`);
    assert.equal(detail.body.balance?.year, 2036);
    assert.equal(detail.body.nextBalance?.year, 2037);
    assert.equal(detail.body.nextBalance?.remaining, ENTITLED - 2);

    assert.equal((await asAdmin(`/requests/${filed.body.id}/decide`, { approve: true })).status, 201);
    const [after2036, after2037] = await heldPair(2036);
    assert.equal(after2036.taken - one.taken, 2);
    assert.equal(after2036.pending, one.pending - 2);
    assert.equal(after2037.taken, 2);
    assert.equal(after2037.pending, 0);
  });

  it("gives both years back when a request across New Year is turned down", async () => {
    const filed = await fileLeave("2047-12-30", "2048-01-03");
    assert.equal(filed.status, 201, JSON.stringify(filed.body));
    assert.equal(Number(filed.body.nextYearDays), 3);
    const [one, two] = await heldPair(2047);
    assert.deepEqual([one.pending, two.pending], [2, 3]);
    const turned = await asAdmin(`/requests/${filed.body.id}/decide`, { approve: false, note: "e2e" });
    assert.equal(turned.status, 201);
    const [back1, back2] = await heldPair(2047);
    assert.deepEqual([back1.pending, back1.taken, back2.pending, back2.taken], [0, 0, 0, 0]);
  });

  it("gives both years back when a request across New Year is cancelled", async () => {
    const was = await held(2036);
    const filed = await fileLeave("2035-12-31", "2036-01-02");
    assert.equal(filed.status, 201, JSON.stringify(filed.body));
    const opened2035 = await held(2035);
    assert.equal(opened2035?.entitled, ENTITLED, "a year after the hire year opened short");
    assert.equal(opened2035?.pending, 1);
    assert.equal((await held(2036))?.pending, (was?.pending ?? 0) + 2);
    const cancelled = await request(http)
      .post(`/requests/${filed.body.id}/cancel`)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(cancelled.status, 201);
    assert.equal((await held(2035))?.pending, 0);
    assert.equal((await held(2036))?.pending, was?.pending);
  });
});
