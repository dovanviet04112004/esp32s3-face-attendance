import assert from "node:assert/strict";
import { after, before, describe, it, mock } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { ScopeService } from "../src/common/scope/scope.service.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { AttendanceListener } from "../src/modules/attendance/attendance.listener.js";
import { RealtimeGateway } from "../src/modules/realtime/realtime.gateway.js";
import { dayAsDate, dayWindow, localDay } from "../src/modules/timesheet/local-day.js";
import { paidLeaveType } from "./fixtures.js";

const LATE = "NV9D01";
const ABSENT = "NV9D02";
const ON_LEAVE = "NV9D03";
const OUTSIDER = "NV9D04";
const EIGHT_OH_FIVE = "NV9D05";
const CODES = [LATE, ABSENT, ON_LEAVE, OUTSIDER, EIGHT_OH_FIVE];
const MANAGER_CODE = "NV0012";
// Due at midnight, so by the time the suite runs a missing punch is already an absence.
const MIDNIGHT_SHIFT = "E2E ca nửa đêm";
const EIGHT_SHIFT = "E2E ca tám giờ";
const DEVICE = "e2e-home-kiosk";
const OTHER_DEVICE = "e2e-home-other";
const MINUTE_MS = 60_000;
const WEEKEND = new Set([0, 6]);

interface Person {
  id: number;
  code: string;
  fullName: string;
}

describe("home page numbers and the punch door (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  const token = { hr: "", manager: "", employee: "" };
  const idOf = new Map<string, number>();
  let today = "";
  let zone = "";
  let dayOff = false;

  async function sweep(): Promise<void> {
    await db.device.deleteMany({ where: { id: { in: [DEVICE, OTHER_DEVICE] } } });
    await db.employee.deleteMany({ where: { code: { in: CODES } } });
    await db.shift.deleteMany({ where: { name: { in: [MIDNIGHT_SHIFT, EIGHT_SHIFT] } } });
  }

  function get(path: string, who: keyof typeof token) {
    return request(http).get(path).set("Authorization", `Bearer ${token[who]}`);
  }

  function localAt(minutes: number): Date {
    return new Date(dayWindow(today, zone).from.getTime() + minutes * MINUTE_MS);
  }

  function codes(list: Person[]): string[] {
    return list.map((one) => one.code);
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
    await sweep();

    const password = env.SEED_ADMIN_PASSWORD ?? "";
    for (const [who, email] of [
      ["hr", "hr@kiosk.local"],
      ["manager", "manager@kiosk.local"],
      ["employee", "employee@kiosk.local"],
    ] as const) {
      const res = await request(http).post("/auth/login").send({ email, password });
      assert.equal(res.status, 200, `${email} could not sign in`);
      token[who] = res.body.accessToken;
    }

    today = localDay(new Date(), zone);
    const date = dayAsDate(today);
    const manager = await db.employee.findUniqueOrThrow({ where: { code: MANAGER_CODE } });
    const holidays = await db.holiday.count({
      where: { date, OR: [{ legalEntityId: null }, { legalEntityId: manager.legalEntityId }] },
    });
    dayOff = WEEKEND.has(date.getUTCDay()) || holidays > 0;

    const midnight = await db.shift.create({
      data: { name: MIDNIGHT_SHIFT, startTime: "00:00", endTime: "23:59", graceMinutes: 0 },
    });
    const eight = await db.shift.create({
      data: { name: EIGHT_SHIFT, startTime: "08:00", endTime: "17:00", graceMinutes: 0 },
    });
    for (const code of CODES) {
      const made = await db.employee.create({
        data: {
          code,
          fullName: `Thử hôm nay ${code}`,
          active: true,
          legalEntityId: manager.legalEntityId,
          managerId: code === OUTSIDER || code === EIGHT_OH_FIVE ? null : manager.id,
        },
      });
      idOf.set(code, made.id);
      // Starting today tests the first day of an assignment, which a timestamp comparison dropped.
      await db.shiftAssignment.create({
        data: { shiftId: code === EIGHT_OH_FIVE ? eight.id : midnight.id, employeeId: made.id, validFrom: date },
      });
    }
    await app.get(ScopeService).forgetScopes();

    await db.device.create({ data: { id: DEVICE, status: "APPROVED" } });
    await db.attendanceRecord.createMany({
      data: [
        { localId: "1", deviceId: DEVICE, employeeId: idOf.get(LATE) as number, ts: localAt(5), direction: "IN" },
        { localId: "2", deviceId: DEVICE, employeeId: idOf.get(LATE) as number, ts: localAt(10), direction: "OUT" },
        { localId: "3", deviceId: DEVICE, employeeId: idOf.get(EIGHT_OH_FIVE) as number, ts: localAt(8 * 60 + 5), direction: "IN" },
        { localId: "4", deviceId: DEVICE, employeeId: idOf.get(EIGHT_OH_FIVE) as number, ts: localAt(12 * 60), direction: "OUT" },
      ],
    });
    const leaveType = await paidLeaveType(db);
    await db.request.create({
      data: {
        employeeId: idOf.get(ON_LEAVE) as number,
        kind: "LEAVE",
        state: "APPROVED",
        leaveTypeId: leaveType.id,
        fromDate: date,
        toDate: date,
        days: 1,
        reason: "e2e",
      },
    });
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("gives a manager today's numbers over their own team only", async () => {
    const mine = await get("/reports/today", "manager");
    assert.equal(mine.status, 200, JSON.stringify(mine.body));
    assert.equal(mine.body.date, today);
    const desk = await get("/reports/today", "hr");
    assert.equal(desk.status, 200);
    for (const field of ["expected", "present", "late", "absentUnexcused", "onLeave"]) {
      assert.ok(desk.body[field] >= mine.body[field], `the manager saw more ${field} than the desk`);
    }
    assert.ok(mine.body.present >= 1 && mine.body.onLeave >= 1);
    if (dayOff) {
      assert.equal(mine.body.expected, 0, "a day off expected somebody");
      assert.equal(mine.body.absentUnexcused, 0);
    } else {
      assert.ok(mine.body.expected >= 3, JSON.stringify(mine.body));
      assert.ok(mine.body.late >= 1, "a punch at 00:05 against a 00:00 shift was not late");
      assert.ok(mine.body.absentUnexcused >= 1);
    }
    assert.equal((await get("/reports/today", "employee")).status, 403);
  });

  it("names who in the team is absent, off or not in yet, and nobody outside it", async () => {
    const team = await get("/reports/team-today", "manager");
    assert.equal(team.status, 200, JSON.stringify(team.body));
    const absent = codes(team.body.absent);
    const onLeave = codes(team.body.onLeave);
    const notPunched = codes(team.body.notPunched);
    const everyone = [...absent, ...onLeave, ...notPunched];
    assert.ok(onLeave.includes(ON_LEAVE), "the person on leave is missing");
    assert.ok(!everyone.includes(LATE), "somebody who punched was listed");
    assert.ok(!everyone.includes(OUTSIDER), "somebody outside the team was listed");
    assert.ok(!everyone.includes(MANAGER_CODE), "the manager was listed in their own team");
    assert.ok(!notPunched.includes(ABSENT), "a shift due at midnight is not still to come");
    assert.equal(absent.includes(ABSENT), !dayOff);
    assert.ok(team.body.totals.onLeave >= 1);
  });

  it("measures lateness in the business time zone, not in UTC", async () => {
    const res = await request(http).get("/reports/attention").set("Authorization", `Bearer ${token.hr}`);
    assert.equal(res.status, 200);
    const rows = res.body.exceptionsToday.rows as { code: string; reason: string; minutes: number }[];
    const eight = rows.find((row) => row.code === EIGHT_OH_FIVE);
    if (dayOff) {
      assert.equal(eight, undefined, "a day off expected somebody");
      return;
    }
    assert.ok(eight, "a punch at 08:05 against an 08:00 shift was not an exception");
    assert.equal(eight.reason, "LATE");
    assert.equal(eight.minutes, 5);
  });

  it("narrows the punch roll-up to who came in late, found by code", async () => {
    const window = dayWindow(today, zone);
    const range = `from=${window.from.toISOString()}&to=${new Date(window.to.getTime() - 1).toISOString()}`;
    const late = await get(`/reports/attendance?${range}&late=true&search=nv9d0&take=200`, "hr");
    assert.equal(late.status, 200, JSON.stringify(late.body));
    const found = (late.body.rows as Person[]).map((row) => row.code).sort();
    assert.deepEqual(found, dayOff ? [] : [LATE, EIGHT_OH_FIVE]);
    const all = await get(`/reports/attendance?${range}&search=${EIGHT_OH_FIVE.toLowerCase()}`, "hr");
    assert.deepEqual((all.body.rows as Person[]).map((row) => row.code), [EIGHT_OH_FIVE]);
  });

  it("drops a punch whose body names another kiosk than its topic", async () => {
    const listener = app.get(AttendanceListener);
    const feed = app.get(RealtimeGateway);
    const told = mock.method(feed, "publish", () => undefined);
    const punch = {
      deviceId: OTHER_DEVICE,
      localId: "900001",
      employeeId: idOf.get(ABSENT) as number,
      ts: Date.now(),
      direction: "IN" as const,
      matchScore: 0.9,
      livenessScore: 0.9,
      modelVersion: 1,
    };
    await listener.onPunch({ topic: "attendance", deviceId: DEVICE, payload: punch, receivedAt: new Date() });
    assert.equal(await db.attendanceRecord.count({ where: { localId: "900001" } }), 0, "a forged punch was stored");

    const honest = { ...punch, deviceId: DEVICE, localId: "900002" };
    await listener.onPunch({ topic: "attendance", deviceId: DEVICE, payload: honest, receivedAt: new Date() });
    await listener.onPunch({ topic: "attendance", deviceId: DEVICE, payload: honest, receivedAt: new Date() });
    told.mock.restore();
    assert.equal(await db.attendanceRecord.count({ where: { deviceId: DEVICE, localId: "900002" } }), 1);
    assert.equal(told.mock.callCount(), 1, "a duplicate reached the live feed");
  });
});
