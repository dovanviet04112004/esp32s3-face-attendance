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

const CODE = "E2ERS01";
const STRANGER = "E2ERS02";
const EMAIL = "e2ers@kiosk.local";
const PASSWORD = "kiosk-e2e-password";
const EARLY = "E2ERS-SANG";
const LATE = "E2ERS-CHIEU";
const HOLIDAY = "E2ERS Ngày nghỉ";
// A month with a Saturday the 7th, chosen so weekends land on known dates.
const YEAR = 2026;
const MONTH = 11;

interface PlannedDay {
  date: string;
  shift: { name: string; startTime: string } | null;
  holiday: string | null;
  weekend: boolean;
  away: string | null;
}

describe("my shift roster (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let admin = "";
  let mine = "";
  let employeeId = 0;
  let strangerId = 0;

  async function sweep(): Promise<void> {
    await db.user.deleteMany({ where: { email: EMAIL } });
    await db.employee.deleteMany({ where: { code: { in: [CODE, STRANGER] } } });
    await db.shift.deleteMany({ where: { name: { in: [EARLY, LATE] } } });
    await db.holiday.deleteMany({ where: { name: HOLIDAY } });
  }

  async function roster(token: string, query = ""): Promise<PlannedDay[]> {
    const res = await request(http)
      .get(`/shifts/roster?year=${YEAR}&month=${MONTH}${query}`)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200, `roster answered ${res.status}`);
    return res.body as PlannedDay[];
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
    admin = signedIn.body.accessToken;

    const made = await db.employee.create({
      data: { code: CODE, fullName: "Người làm ca", active: true },
    });
    employeeId = made.id;
    const other = await db.employee.create({
      data: { code: STRANGER, fullName: "Người khác", active: true },
    });
    strangerId = other.id;
    await db.user.create({
      data: {
        email: EMAIL,
        passwordHash: await hashPassword(PASSWORD),
        role: "EMPLOYEE",
        employeeId,
      },
    });

    const early = await db.shift.create({
      data: { name: EARLY, startTime: "06:00", endTime: "14:00", graceMinutes: 5 },
    });
    const late = await db.shift.create({
      data: { name: LATE, startTime: "14:00", endTime: "22:00", graceMinutes: 5 },
    });
    // The early shift all month, then the late one from the 16th: a roster
    // change is a second row, not an edit of the first.
    await db.shiftAssignment.create({
      data: { shiftId: early.id, employeeId, validFrom: new Date(Date.UTC(YEAR, MONTH - 1, 1)) },
    });
    await db.shiftAssignment.create({
      data: { shiftId: late.id, employeeId, validFrom: new Date(Date.UTC(YEAR, MONTH - 1, 16)) },
    });
    await db.holiday.create({
      data: { date: new Date(Date.UTC(YEAR, MONTH - 1, 20)), name: HOLIDAY, paid: true },
    });
    await db.request.create({
      data: {
        employeeId,
        kind: "LEAVE",
        state: "APPROVED",
        fromDate: new Date(Date.UTC(YEAR, MONTH - 1, 10)),
        toDate: new Date(Date.UTC(YEAR, MONTH - 1, 11)),
        days: 2,
        reason: "e2e",
      },
    });

    const asMe = await request(http).post("/auth/login").send({ email: EMAIL, password: PASSWORD });
    assert.equal(asMe.status, 200, "the employee could not sign in");
    mine = asMe.body.accessToken;
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("answers for every day of the month asked for", async () => {
    const days = await roster(mine);
    assert.equal(days.length, 30, "November has thirty days");
    assert.equal(days[0].date, `${YEAR}-${MONTH}-01`);
    assert.equal(days[29].date, `${YEAR}-${MONTH}-30`);
  });

  it("shows the shift in force on each day, and the change partway", async () => {
    const days = await roster(mine);
    assert.equal(days[0].shift?.name, EARLY, "the first half is the early shift");
    assert.equal(days[14].shift?.name, EARLY, "the 15th is still the early shift");
    assert.equal(days[15].shift?.name, LATE, "the 16th moves to the late shift");
    assert.equal(days[29].shift?.startTime, "14:00");
  });

  it("marks the holiday, the weekend and the days away", async () => {
    const days = await roster(mine);
    assert.equal(days[19].holiday, HOLIDAY, "the 20th is the holiday");
    assert.equal(days[9].away, "LEAVE", "the 10th is approved leave");
    assert.equal(days[10].away, "LEAVE", "the 11th is the second day of it");
    assert.equal(days[11].away, null, "the 12th is back at work");
    const weekends = days.filter((one) => one.weekend).length;
    assert.equal(weekends, 9, "November 2026 has nine weekend days");
  });

  // A month earlier than the first assignment, not later than the last: the
  // late shift has no end date, so every later month is covered on purpose.
  it("answers a month with no assignment empty rather than failing", async () => {
    const res = await request(http)
      .get(`/shifts/roster?year=${YEAR}&month=1`)
      .set("Authorization", `Bearer ${mine}`);
    assert.equal(res.status, 200);
    const days = res.body as PlannedDay[];
    assert.equal(days.length, 31);
    assert.ok(
      days.every((one) => one.shift === null),
      "a month earlier than any assignment still claims a shift",
    );
  });

  it("carries an open-ended assignment into later months", async () => {
    const res = await request(http)
      .get(`/shifts/roster?year=${YEAR + 1}&month=1`)
      .set("Authorization", `Bearer ${mine}`);
    assert.equal(res.status, 200);
    assert.equal((res.body as PlannedDay[])[0].shift?.name, LATE);
  });

  it("gives an employee their own roster and nobody else's", async () => {
    const res = await request(http)
      .get(`/shifts/roster?year=${YEAR}&month=${MONTH}&employeeId=${strangerId}`)
      .set("Authorization", `Bearer ${mine}`);
    assert.equal(res.status, 404, "an employee read somebody else's roster");
  });

  it("lets the desk read anybody's", async () => {
    const days = await roster(admin, `&employeeId=${employeeId}`);
    assert.equal(days[0].shift?.name, EARLY);
  });

  it("refuses a month that is not a month", async () => {
    const res = await request(http)
      .get(`/shifts/roster?year=${YEAR}&month=13`)
      .set("Authorization", `Bearer ${mine}`);
    assert.equal(res.status, 400);
  });
});
