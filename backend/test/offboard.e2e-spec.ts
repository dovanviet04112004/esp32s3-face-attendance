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
import { EmployeesService } from "../src/modules/employees/employees.service.js";
import { PayrollService } from "../src/modules/payroll/payroll.service.js";

const LEAVER = "E2EOB01";
const TODAY_LEAVER = "E2EOB02";
const CANCELLER = "E2EOB03";
const CODES = [LEAVER, TODAY_LEAVER, CANCELLER];
const EMAIL = "e2eob@kiosk.local";
const TODAY_EMAIL = "e2eob2@kiosk.local";
const PASSWORD = "kiosk-e2e-password";
const ASSET = "E2EOB-AS1";
const DEPARTMENT = "E2EOB-D";
const DEVICE = "e2eob-kiosk";
const YEAR = 2027;
const MONTH = 10;
// Ahead of the real clock, so recording them only schedules, and inside the AttendanceDay partitions.
const FIRST_LAST_DAY = "2027-10-15";
const LAST_DAY = "2027-10-20";
const MORNING_AFTER = "2027-10-21";
const LATER = "2027-10-30";
const WORKED_DAYS = 10;
const MINUTES_PER_DAY = 480;
const BASE_SALARY = "20000000";

interface Report {
  code: string;
  leaveDate: string;
  closed: boolean;
  assetsOutstanding: { code: string }[];
  requestsPending: number;
}

function cookieOf(res: request.Response): string {
  return (res.headers["set-cookie"] as unknown as string[])[0] as string;
}

describe("offboarding (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let employees: EmployeesService;
  let payroll: PayrollService;
  let token = "";
  let refreshCookie = "";
  let periodId = "";
  let departmentId = "";
  const id: Record<string, number> = {};

  const as = (method: "post" | "patch" | "delete" | "get", path: string) =>
    request(http)[method](path).set("Authorization", `Bearer ${token}`);

  const signIn = (email: string) => request(http).post("/auth/login").send({ email, password: PASSWORD });

  async function sweep(): Promise<void> {
    await db.asset.deleteMany({ where: { code: ASSET } });
    await db.user.deleteMany({ where: { email: { in: [EMAIL, TODAY_EMAIL] } } });
    await db.employee.deleteMany({ where: { code: { in: CODES } } });
    await db.payrollPeriod.deleteMany({ where: { year: YEAR, month: MONTH } });
    await db.department.deleteMany({ where: { code: DEPARTMENT } });
    await db.device.deleteMany({ where: { id: DEVICE } });
  }

  before(async () => {
    const env = validateEnv();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    http = app.getHttpServer();
    db = app.get(PrismaService);
    employees = app.get(EmployeesService);
    payroll = app.get(PayrollService);
    await sweep();

    const signedIn = await request(http)
      .post("/auth/login")
      .send({ email: "admin@kiosk.local", password: env.SEED_ADMIN_PASSWORD ?? "" });
    assert.equal(signedIn.status, 200, "admin could not sign in");
    token = signedIn.body.accessToken;

    const template = await db.employee.findFirstOrThrow({
      where: { active: true, legalEntityId: { not: null } },
    });
    const entityId = template.legalEntityId as string;
    // A department of its own, so the payroll run below pays nobody another suite holds.
    departmentId = (await db.department.create({ data: { legalEntityId: entityId, code: DEPARTMENT, name: "Thử nghỉ việc" } })).id;
    for (const code of CODES) {
      const made = await db.employee.create({
        data: {
          code,
          fullName: `Sắp nghỉ việc ${code}`,
          active: true,
          legalEntityId: entityId,
          departmentId,
          hireDate: new Date("2024-01-01T00:00:00.000Z"),
        },
      });
      id[code] = made.id;
    }
    const passwordHash = await hashPassword(PASSWORD);
    await db.user.createMany({
      data: [
        { email: EMAIL, passwordHash, role: "EMPLOYEE", employeeId: id[LEAVER] },
        { email: TODAY_EMAIL, passwordHash, role: "EMPLOYEE", employeeId: id[TODAY_LEAVER] },
      ],
    });
    await db.compensationRecord.create({
      data: {
        employeeId: id[LEAVER],
        effectiveFrom: new Date("2024-01-01T00:00:00.000Z"),
        baseSalary: BASE_SALARY,
        insuranceSalary: BASE_SALARY,
      },
    });
    await db.attendanceDay.createMany({
      data: Array.from({ length: WORKED_DAYS }, (_, at) => ({
        employeeId: id[LEAVER],
        date: new Date(Date.UTC(YEAR, MONTH - 1, at + 1)),
        state: "WORKED" as const,
        workedMinutes: MINUTES_PER_DAY,
        punchCount: 2,
      })),
    });
    await db.device.create({ data: { id: DEVICE, status: "APPROVED" } });
    await db.deviceEnrollment.create({ data: { deviceId: DEVICE, employeeId: id[LEAVER], state: "ENROLLED" } });

    const period = await db.payrollPeriod.create({
      data: {
        year: YEAR,
        month: MONTH,
        legalEntityId: entityId,
        startDate: new Date(Date.UTC(YEAR, MONTH - 1, 1)),
        endDate: new Date(Date.UTC(YEAR, MONTH, 0)),
      },
    });
    periodId = period.id;

    const asset = await db.asset.create({
      data: { code: ASSET, name: "Máy chưa thu", kind: "LAPTOP" },
    });
    await as("post", `/assets/${asset.id}/hand-over`).send({ employeeId: id[LEAVER], issued: true });
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("lets the account in while it is open, and keeps a session", async () => {
    const res = await signIn(EMAIL);
    assert.equal(res.status, 200);
    refreshCookie = cookieOf(res);
    assert.ok(refreshCookie, "the login handed back a refresh cookie");
  });

  it("schedules a last day still ahead and keeps the person working", async () => {
    const res = await as("post", `/employees/${id[LEAVER]}/offboard`).send({ leaveDate: FIRST_LAST_DAY, reason: "e2e" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const report = res.body as Report;
    assert.equal(report.code, LEAVER);
    assert.equal(report.closed, false);
    assert.deepEqual(
      report.assetsOutstanding.map((one) => one.code),
      [ASSET],
      "the laptop they still hold has to come back in the answer",
    );

    const person = await db.employee.findUniqueOrThrow({ where: { id: id[LEAVER] } });
    assert.equal(person.active, true, "a person with days left to work fell out of the roster");
    assert.equal(person.leaveDate?.toISOString().slice(0, 10), FIRST_LAST_DAY);
    const login = await db.user.findUniqueOrThrow({ where: { email: EMAIL } });
    assert.equal(login.active, true);
    const kiosk = await db.deviceEnrollment.findUniqueOrThrow({
      where: { deviceId_employeeId: { deviceId: DEVICE, employeeId: id[LEAVER] } },
    });
    assert.equal(kiosk.state, "ENROLLED", "the kiosk dropped a face that still comes to work");
  });

  it("keeps both ways into the account open until the record closes", async () => {
    assert.equal((await signIn(EMAIL)).status, 200, "a scheduled leaver could not sign in");
    const renewed = await request(http).post("/auth/refresh").set("Cookie", refreshCookie);
    assert.equal(renewed.status, 200, "a session opened before the schedule died with it");
    refreshCookie = cookieOf(renewed);
  });

  it("refuses a second recording while one is scheduled", async () => {
    const res = await as("post", `/employees/${id[LEAVER]}/offboard`).send({ leaveDate: LAST_DAY });
    assert.equal(res.status, 409);
    assert.equal(res.body.message, "LEAVING_SCHEDULED");
  });

  it("puts the unreturned asset in front of whoever locks the period", async () => {
    const res = await as("get", `/payroll-periods/${periodId}/checklist`);
    assert.equal(res.status, 200);
    const item = (res.body as { code: string; count: number }[]).find(
      (one) => one.code === "LEAVERS_HOLDING_ASSETS",
    );
    assert.ok(item, "the checklist never mentions unreturned assets");
    assert.ok(item.count >= 1, "the scheduled leaver holding a laptop is not counted");
  });

  it("moves a scheduled last day without closing anything", async () => {
    const res = await as("patch", `/employees/${id[LEAVER]}/offboard`).send({ leaveDate: LAST_DAY });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((res.body as Report).closed, false);
    const person = await db.employee.findUniqueOrThrow({ where: { id: id[LEAVER] } });
    assert.equal(person.leaveDate?.toISOString().slice(0, 10), LAST_DAY);
    assert.equal(person.active, true);
  });

  it("closes a last day of today at once, login and all", async () => {
    const opened = await signIn(TODAY_EMAIL);
    assert.equal(opened.status, 200);
    const res = await as("post", `/employees/${id[TODAY_LEAVER]}/offboard`).send({ leaveDate: employees.today() });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal((res.body as Report).closed, true);
    assert.equal((await db.employee.findUniqueOrThrow({ where: { id: id[TODAY_LEAVER] } })).active, false);
    assert.equal((await signIn(TODAY_EMAIL)).status, 401, "a closed account still signed in");
    const renewed = await request(http).post("/auth/refresh").set("Cookie", cookieOf(opened));
    assert.equal(renewed.status, 401, "a session outlived the record closing");
  });

  it("calls off a schedule, and has nothing to move or cancel afterwards", async () => {
    const scheduled = await as("post", `/employees/${id[CANCELLER]}/offboard`).send({ leaveDate: FIRST_LAST_DAY });
    assert.equal(scheduled.status, 201);
    const cancelled = await as("delete", `/employees/${id[CANCELLER]}/offboard`);
    assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
    assert.equal(cancelled.body.leaveDate, null);
    assert.equal(cancelled.body.active, true);

    const moved = await as("patch", `/employees/${id[CANCELLER]}/offboard`).send({ leaveDate: LAST_DAY });
    assert.equal(moved.status, 409);
    assert.equal(moved.body.message, "LEAVING_NOT_SCHEDULED");
    const again = await as("delete", `/employees/${id[CANCELLER]}/offboard`);
    assert.equal(again.status, 409);
    assert.equal(again.body.message, "LEAVING_NOT_SCHEDULED");
  });

  it("closes at once when a schedule moves onto today", async () => {
    const scheduled = await as("post", `/employees/${id[CANCELLER]}/offboard`).send({ leaveDate: FIRST_LAST_DAY });
    assert.equal(scheduled.status, 201);
    const moved = await as("patch", `/employees/${id[CANCELLER]}/offboard`).send({ leaveDate: employees.today() });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal((moved.body as Report).closed, true);
    assert.equal((await db.employee.findUniqueOrThrow({ where: { id: id[CANCELLER] } })).active, false);
  });

  it("leaves the record open through the last day itself", async () => {
    const closed = await employees.closeDue(LAST_DAY);
    assert.ok(!closed.includes(id[LEAVER]), "the job closed somebody on their last working day");
    assert.equal((await db.employee.findUniqueOrThrow({ where: { id: id[LEAVER] } })).active, true);
  });

  it("closes the record the morning after, the way the desk would", async () => {
    const closed = await employees.closeDue(MORNING_AFTER);
    assert.ok(closed.includes(id[LEAVER]), "the job left a past last day open");

    const person = await db.employee.findUniqueOrThrow({ where: { id: id[LEAVER] } });
    assert.equal(person.active, false);
    assert.equal(person.leaveDate?.toISOString().slice(0, 10), LAST_DAY);
    assert.equal((await db.user.findUniqueOrThrow({ where: { email: EMAIL } })).active, false);
    assert.equal((await signIn(EMAIL)).status, 401, "a closed account still signed in");
    const renewed = await request(http).post("/auth/refresh").set("Cookie", refreshCookie);
    assert.equal(renewed.status, 401, "a session outlived the record closing");
    const kiosk = await db.deviceEnrollment.findUniqueOrThrow({
      where: { deviceId_employeeId: { deviceId: DEVICE, employeeId: id[LEAVER] } },
    });
    assert.equal(kiosk.state, "REVOKED", "the face of somebody who left stayed on the kiosk");

    const entries = await db.auditLog.findMany({
      where: { action: "employee.deactivate", subjectType: "employee", subjectId: String(id[LEAVER]) },
    });
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.actorId, null, "nobody pressed anything, so nobody signs the entry");
  });

  it("changes nothing when the job runs a second time", async () => {
    const before = await db.employee.findUniqueOrThrow({ where: { id: id[LEAVER] } });
    const closed = await employees.closeDue(MORNING_AFTER);
    assert.ok(!closed.includes(id[LEAVER]), "a second run closed the record again");
    const after = await db.employee.findUniqueOrThrow({ where: { id: id[LEAVER] } });
    assert.equal(after.updatedAt.getTime(), before.updatedAt.getTime());
    const entries = await db.auditLog.count({
      where: { action: "employee.deactivate", subjectType: "employee", subjectId: String(id[LEAVER]) },
    });
    assert.equal(entries, 1, "a second run wrote a second closing");
  });

  it("refuses to move, cancel or record again once the record has closed", async () => {
    const moved = await as("patch", `/employees/${id[LEAVER]}/offboard`).send({ leaveDate: LATER });
    assert.equal(moved.status, 409);
    assert.equal(moved.body.message, "LEAVING_CLOSED");
    const cancelled = await as("delete", `/employees/${id[LEAVER]}/offboard`);
    assert.equal(cancelled.status, 409);
    assert.equal(cancelled.body.message, "LEAVING_CLOSED");
    const recorded = await as("post", `/employees/${id[LEAVER]}/offboard`).send({ leaveDate: LATER });
    assert.equal(recorded.status, 409);
    assert.equal(recorded.body.message, "EMPLOYEE_HAS_LEFT");
  });

  it("still pays the days worked in the last month", async () => {
    const run = await db.payrollRun.create({ data: { periodId, kind: "REGULAR", state: "DRAFT", departmentId } });
    await payroll.runNow(run.id);
    const slip = await db.payslip.findFirst({ where: { runId: run.id, employeeId: id[LEAVER] } });
    assert.ok(slip, "the closed leaver fell out of the run for their last month");
    assert.equal(Number(slip.workedDays), WORKED_DAYS);
    assert.ok(Number(slip.grossPay) > 0, "the days they worked were paid nothing");
    const others = await db.payslip.count({ where: { runId: run.id, employeeId: { not: id[LEAVER] } } });
    assert.equal(others, 0, "somebody who left before the period began was paid in it");
  });
});
