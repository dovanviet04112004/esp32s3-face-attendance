import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { TimesheetService } from "../src/modules/timesheet/timesheet.service.js";

// A Monday the seed never touches, inside the partition range, with no holiday
// on it: building it writes a fresh day for everyone and disturbs no history.
const DAY = "2026-03-16";

// One person per scenario, because an exclusion constraint refuses a second
// leave request overlapping the first.
const AHEAD = "NV9101";
const BEHIND = "NV9102";
const MEASURED = "NV9103";
const HALF = "NV9104";
const MADE_CODES = [AHEAD, BEHIND, MEASURED, HALF];

describe("timesheet leave (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let timesheet: TimesheetService;
  let adminToken = "";
  let leaveTypeId = "";
  const idOf = new Map<string, number>();

  const date = new Date(`${DAY}T00:00:00.000Z`);

  async function sweep(): Promise<void> {
    await db.attendanceDay.deleteMany({ where: { date } });
    await db.employee.deleteMany({ where: { code: { in: MADE_CODES } } });
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

    const type = await db.leaveType.findFirstOrThrow({ where: { active: true, paid: true } });
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
  });

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
    const rows = res.body as { employeeId: number; leaveDays: number; absentDays: number }[];
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
});
