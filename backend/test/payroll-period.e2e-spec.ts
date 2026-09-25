import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { hashPassword } from "../src/modules/auth/password.js";
import { PayrollService } from "../src/modules/payroll/payroll.service.js";
import { dayWindow } from "../src/modules/timesheet/local-day.js";
import { TimesheetService } from "../src/modules/timesheet/timesheet.service.js";

// An entity of its own, so every run and lock here reaches only the people this suite made.
const ENTITY_CODE = "E2E-PAYC";
const DEPARTMENT_CODE = "E2E-PAYC-D";
const STEADY = "NV9C01";
const ABSENT = "NV9C02";
const OVERTIME = "NV9C03";
const CODES = [STEADY, ABSENT, OVERTIME];
const DEVICE = "e2e-payc-kiosk";
const STEADY_EMAIL = "nv9c01@kiosk.local";
const STEADY_PASSWORD = "kiosk-e2e-password";
const HR_CODE = "NV0010";
const PAYROLL_CODE = "NV0011";
// A Saturday and a Monday of February 2026 no other suite builds.
const SATURDAY = "2026-02-07";
const HOLIDAY = "2026-02-09";
const OWN_DAY = "2026-02-10";
const WIDE_FROM = "2026-01-17";
const WIDE_YEAR = 2031;
const WIDE_MONTH = 5;
const BASE = 26_000_000;
const ADVANCE = 1_000_000;
const FOUR_HOURS = 240;
const MINUTE_MS = 60_000;
const SETTLE_MS = 30_000;
const POLL_MS = 200;

const BRACKETS = [
  { upToAmount: 10_000_000, rateBp: 500 },
  { upToAmount: 30_000_000, rateBp: 1000 },
  { upToAmount: 60_000_000, rateBp: 2000 },
  { upToAmount: 100_000_000, rateBp: 3000 },
  { rateBp: 3500 },
];

function policyFields(effectiveFrom: string) {
  return {
    effectiveFrom,
    selfDeduction: 15_500_000,
    dependentDeduction: 6_200_000,
    socialRateBp: 800,
    healthRateBp: 150,
    unemploymentRateBp: 100,
    employerSocialRateBp: 1750,
    employerHealthRateBp: 300,
    employerUnemploymentRateBp: 100,
    referenceWage: 2_340_000,
    socialCapMultiple: 20,
    regionalMinimumWage: 5_310_000,
    unemploymentCapMultiple: 20,
    standardDaysPerMonth: 26,
    noContributionUnpaidDays: 14,
    overtimeWeekdayBp: 15_000,
    overtimeWeekendBp: 20_000,
    overtimeHolidayBp: 30_000,
    nightPremiumBp: 3_000,
  };
}

function dateOf(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

describe("payroll periods, runs and the timesheet behind them (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let payroll: PayrollService;
  let timesheet: TimesheetService;
  const token = { admin: "", hr: "", payroll: "", steady: "" };
  const idOf = new Map<string, number>();
  let entityId = "";
  let departmentId = "";
  let policyId = "";
  let periodId = "";
  let firstRunId = "";
  let secondRunId = "";
  let zone = "";

  async function sweep(): Promise<void> {
    await db.auditLog.deleteMany({ where: { subjectType: "device", subjectId: DEVICE } });
    await db.device.deleteMany({ where: { id: DEVICE } });
    await db.user.deleteMany({ where: { email: STEADY_EMAIL } });
    await db.attendanceDay.deleteMany({ where: { employee: { code: HR_CODE }, date: dateOf(OWN_DAY) } });
    await db.payrollPeriod.deleteMany({ where: { legalEntity: { code: ENTITY_CODE } } });
    await db.payrollPeriod.deleteMany({ where: { legalEntityId: null, year: WIDE_YEAR, month: WIDE_MONTH } });
    await db.payrollPolicy.deleteMany({ where: { legalEntityId: null, effectiveFrom: dateOf(WIDE_FROM) } });
    await db.employee.deleteMany({ where: { code: { in: CODES } } });
    await db.department.deleteMany({ where: { code: DEPARTMENT_CODE } });
    await db.legalEntity.deleteMany({ where: { code: ENTITY_CODE } });
  }

  async function signIn(email: string, password: string): Promise<string> {
    const res = await request(http).post("/auth/login").send({ email, password });
    assert.equal(res.status, 200, `${email} could not sign in`);
    return res.body.accessToken as string;
  }

  function as(who: keyof typeof token) {
    return {
      get: (path: string) => request(http).get(path).set("Authorization", `Bearer ${token[who]}`),
      post: (path: string, body?: object) =>
        request(http).post(path).set("Authorization", `Bearer ${token[who]}`).send(body ?? {}),
      patch: (path: string, body: object) =>
        request(http).patch(path).set("Authorization", `Bearer ${token[who]}`).send(body),
    };
  }

  function localAt(day: string, minutes: number): Date {
    return new Date(dayWindow(day, zone).from.getTime() + minutes * MINUTE_MS);
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
    payroll = app.get(PayrollService);
    timesheet = app.get(TimesheetService);
    await sweep();

    const password = env.SEED_ADMIN_PASSWORD ?? "";
    token.admin = await signIn("admin@kiosk.local", password);
    token.hr = await signIn("hr@kiosk.local", password);
    token.payroll = await signIn("payroll@kiosk.local", password);

    const entity = await db.legalEntity.create({ data: { code: ENTITY_CODE, name: "Pháp nhân thử lương" } });
    entityId = entity.id;
    const department = await db.department.create({
      data: { legalEntityId: entityId, code: DEPARTMENT_CODE, name: "Phòng thử lương" },
    });
    departmentId = department.id;
    const policy = await db.payrollPolicy.create({
      data: {
        ...policyFields("2026-01-01"),
        effectiveFrom: dateOf("2026-01-01"),
        legalEntityId: entityId,
        brackets: { create: BRACKETS.map((band, at) => ({ ordinal: at + 1, upToAmount: band.upToAmount ?? null, rateBp: band.rateBp })) },
      },
    });
    policyId = policy.id;

    for (const code of CODES) {
      const made = await db.employee.create({
        data: {
          code,
          fullName: `Thử kỳ lương ${code}`,
          active: true,
          legalEntityId: entityId,
          departmentId,
          hireDate: dateOf("2025-01-01"),
        },
      });
      idOf.set(code, made.id);
      const record = await db.compensationRecord.create({
        data: { employeeId: made.id, effectiveFrom: dateOf("2025-01-01"), baseSalary: BASE, insuranceSalary: BASE },
      });
      if (code === ABSENT) {
        await db.compensationAllowance.createMany({
          data: [
            { recordId: record.id, code: "LUNCH", label: "Ăn trưa", amount: 1_000_000, taxable: true, taxFreeCap: 730_000 },
            { recordId: record.id, code: "PHONE", label: "Điện thoại", amount: 500_000, taxable: true, taxFreeCap: 800_000 },
          ],
        });
      }
    }
    await db.user.create({
      data: {
        email: STEADY_EMAIL,
        passwordHash: await hashPassword(STEADY_PASSWORD),
        role: "EMPLOYEE",
        employeeId: idOf.get(STEADY) as number,
      },
    });
    token.steady = await signIn(STEADY_EMAIL, STEADY_PASSWORD);

    const steadyId = idOf.get(STEADY) as number;
    await db.attendanceDay.createMany({
      data: [
        ...["2026-02-02", "2026-02-03", "2026-02-04"].map((day) => ({
          employeeId: steadyId,
          date: dateOf(day),
          state: "WORKED" as const,
          workedMinutes: 480,
          punchCount: 2,
        })),
        { employeeId: idOf.get(ABSENT) as number, date: dateOf("2026-02-03"), state: "ABSENT" as const },
        { employeeId: steadyId, date: dateOf("2026-01-05"), state: "WORKED" as const, workedMinutes: 480, punchCount: 2 },
        {
          employeeId: steadyId,
          date: dateOf("2026-01-06"),
          state: "WORKED" as const,
          workedMinutes: 468,
          lateMinutes: 12,
          punchCount: 2,
        },
        { employeeId: steadyId, date: dateOf("2026-01-07"), state: "WORKED" as const, workedMinutes: 0, punchCount: 1 },
      ],
    });
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("refuses a second period for one entity and month, company-wide included", async () => {
    const first = await as("payroll").post("/payroll-periods", { legalEntityId: entityId, year: 2026, month: 2 });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    periodId = first.body.id;
    const again = await as("payroll").post("/payroll-periods", { legalEntityId: entityId, year: 2026, month: 2 });
    assert.equal(again.status, 409);
    assert.equal(again.body.message, "PERIOD_TAKEN");

    const wide = await as("payroll").post("/payroll-periods", { year: WIDE_YEAR, month: WIDE_MONTH });
    assert.equal(wide.status, 201, JSON.stringify(wide.body));
    const wideAgain = await as("payroll").post("/payroll-periods", { year: WIDE_YEAR, month: WIDE_MONTH });
    assert.equal(wideAgain.status, 409, "two company-wide periods for one month were both accepted");
  });

  it("prices a weekend and a holiday worked as overtime, at their own rates", async () => {
    const overtimeId = idOf.get(OVERTIME) as number;
    await db.holiday.create({ data: { legalEntityId: entityId, date: dateOf(HOLIDAY), name: "Ngày lễ thử", paid: true } });
    await db.device.create({ data: { id: DEVICE, status: "APPROVED" } });
    let localId = 0;
    for (const day of [SATURDAY, HOLIDAY]) {
      await db.attendanceRecord.createMany({
        data: [8 * 60, 12 * 60].map((minutes) => {
          localId += 1;
          return { localId: String(localId), deviceId: DEVICE, employeeId: overtimeId, ts: localAt(day, minutes), direction: "IN" };
        }),
      });
      await db.request.create({
        data: {
          employeeId: overtimeId,
          kind: "OVERTIME",
          state: "APPROVED",
          fromDate: dateOf(day),
          toDate: dateOf(day),
          minutes: FOUR_HOURS,
          reason: "e2e",
        },
      });
      await timesheet.build(day);
    }

    const weekend = await db.attendanceDay.findFirstOrThrow({ where: { employeeId: overtimeId, date: dateOf(SATURDAY) } });
    assert.equal(weekend.calendar, "WEEKEND");
    assert.equal(weekend.state, "WORKED");
    assert.equal(weekend.overtimeMinutes, FOUR_HOURS, "every minute worked on a day off is overtime");
    const holiday = await db.attendanceDay.findFirstOrThrow({ where: { employeeId: overtimeId, date: dateOf(HOLIDAY) } });
    assert.equal(holiday.calendar, "HOLIDAY");
    assert.equal(holiday.overtimeMinutes, FOUR_HOURS);
    const off = await db.attendanceDay.findFirstOrThrow({ where: { employeeId: idOf.get(STEADY), date: dateOf(HOLIDAY) } });
    assert.equal(off.state, "HOLIDAY", "the entity's holiday did not reach its own people");

    const run = await db.payrollRun.create({ data: { periodId, kind: "REGULAR" } });
    firstRunId = run.id;
    await payroll.runNow(firstRunId);
    const slip = await db.payslip.findFirstOrThrow({
      where: { runId: firstRunId, employeeId: overtimeId },
      include: { lines: true },
    });
    const amount = (code: string) => Number(slip.lines.find((line) => line.code === code)?.amount ?? 0);
    assert.ok(amount("OT_WEEKEND") > 0, "the weekend bucket stayed empty");
    assert.ok(amount("OT_HOLIDAY") > 0, "the holiday bucket stayed empty");
    assert.ok(amount("OT_HOLIDAY") > amount("OT_WEEKEND"), "a holiday hour must cost more than a weekend hour");
    assert.equal(Number(slip.workedDays), 0, "a day off worked is paid as overtime, not as a base day too");
  });

  it("taxes an allowance only above its tax-free cap", async () => {
    const slip = await db.payslip.findFirstOrThrow({ where: { runId: firstRunId, employeeId: idOf.get(ABSENT) } });
    // 730,000 of lunch sits under its cap and all 500,000 of phone under its own; 270,000 is taxed.
    assert.equal(Number(slip.grossPay) - Number(slip.taxableIncome), 730_000 + 500_000);
  });

  it("issues one payslip per person from the newest finished run, and settles only what it carried", async () => {
    const steadyId = idOf.get(STEADY) as number;
    const carried = await db.salaryAdvance.create({
      data: { employeeId: steadyId, amount: ADVANCE, reason: "e2e", state: "PAID", paidAt: new Date() },
    });
    const second = await db.payrollRun.create({ data: { periodId, kind: "REGULAR" } });
    secondRunId = second.id;
    await payroll.runNow(secondRunId);
    const late = await db.salaryAdvance.create({
      data: { employeeId: steadyId, amount: ADVANCE, reason: "e2e late", state: "PAID", paidAt: new Date() },
    });
    const broken = await db.payrollRun.create({ data: { periodId, kind: "REGULAR", state: "FAILED" } });
    const leftover = await db.payslip.create({
      data: { runId: broken.id, periodId, employeeId: steadyId, policyId, grossPay: 1, netPay: 1 },
    });

    const locked = await as("payroll").post(`/payroll-periods/${periodId}/lock`, { acceptOpenItems: true });
    assert.equal(locked.status, 201, JSON.stringify(locked.body));

    const issued = await db.payslip.findMany({ where: { periodId, state: { not: "DRAFT" } } });
    assert.equal(issued.length, CODES.length, "two regular runs issued two sets");
    assert.ok(issued.every((one) => one.runId === secondRunId), "a slip of an older run was issued");
    assert.equal((await db.payslip.findUniqueOrThrow({ where: { id: leftover.id } })).state, "DRAFT");
    assert.equal(await db.payslip.count({ where: { runId: firstRunId, state: { not: "DRAFT" } } }), 0);

    const steadySlip = issued.find((one) => one.employeeId === steadyId);
    const settled = await db.salaryAdvance.findUniqueOrThrow({ where: { id: carried.id } });
    assert.equal(settled.state, "SETTLED");
    assert.equal(settled.payslipId, steadySlip?.id);
    assert.equal((await db.salaryAdvance.findUniqueOrThrow({ where: { id: late.id } })).state, "PAID");
  });

  it("never shows its owner a draft, only what was issued", async () => {
    const mine = await as("steady").get("/payslips");
    assert.equal(mine.status, 200);
    const rows = mine.body.rows as { id: string; state: string }[];
    assert.ok(rows.length >= 1, "the issued payslip is missing");
    assert.ok(rows.every((row) => row.state !== "DRAFT"), "a draft reached its owner");
    const draft = await db.payslip.findFirstOrThrow({ where: { runId: firstRunId, employeeId: idOf.get(STEADY) } });
    const peek = await as("steady").get(`/payslips/${draft.id}`);
    assert.equal(peek.status, 404);
  });

  it("sums the period over what it issued, and finds one payslip with its advance", async () => {
    const totals = await as("hr").get(`/payroll-periods/${periodId}/totals`);
    assert.equal(totals.status, 200);
    assert.equal(totals.body.payslips, CODES.length);
    assert.equal(totals.body.people, CODES.length);
    assert.equal(
      BigInt(totals.body.employerCost),
      BigInt(totals.body.gross) + BigInt(totals.body.insuranceEmployer),
    );
    const found = await as("hr").get(`/payslips?periodId=${periodId}&issued=true&search=${STEADY.toLowerCase()}`);
    assert.equal(found.status, 200);
    assert.equal(found.body.rows.length, 1);
    assert.equal(found.body.rows[0].employee.code, STEADY);
    assert.equal(found.body.rows[0].advance, String(ADVANCE));
    const file = await as("hr").get(`/payslips/export?periodId=${periodId}&issued=true`);
    assert.equal(file.status, 200);
    assert.match(String(file.headers["content-type"]), /text\/csv/);
    assert.ok(file.text.includes(OVERTIME));
  });

  it("refuses a lock while a run is going, and claims a run once when execute is pressed twice", async () => {
    const march = await db.payrollPeriod.create({
      data: { legalEntityId: entityId, year: 2026, month: 3, startDate: dateOf("2026-03-01"), endDate: dateOf("2026-03-31") },
    });
    const busy = await db.payrollRun.create({ data: { periodId: march.id, kind: "REGULAR", state: "RUNNING" } });
    const blocked = await as("payroll").post(`/payroll-periods/${march.id}/lock`, { acceptOpenItems: true });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.message, "PERIOD_RUN_IN_PROGRESS");
    assert.equal((await db.payrollPeriod.findUniqueOrThrow({ where: { id: march.id } })).state, "OPEN");
    await db.payrollRun.update({ where: { id: busy.id }, data: { state: "FAILED" } });

    const run = await db.payrollRun.create({ data: { periodId: march.id, kind: "REGULAR" } });
    const presses = await Promise.all([
      as("payroll").post(`/payroll-runs/${run.id}/execute`),
      as("payroll").post(`/payroll-runs/${run.id}/execute`),
    ]);
    const statuses = presses.map((one) => one.status).sort();
    assert.deepEqual(statuses, [201, 400], JSON.stringify(presses.map((one) => one.body)));
    assert.equal(presses.find((one) => one.status === 400)?.body.message, "RUN_ALREADY_RUNNING");

    let state = "RUNNING";
    for (let waited = 0; waited < SETTLE_MS && state === "RUNNING"; waited += POLL_MS) {
      await sleep(POLL_MS);
      state = (await db.payrollRun.findUniqueOrThrow({ where: { id: run.id } })).state;
    }
    assert.equal(state, "DONE", "the run was left behind on RUNNING");
  });

  it("refuses a bonus somebody loads for themselves", async () => {
    const march = await db.payrollPeriod.findFirstOrThrow({ where: { legalEntityId: entityId, year: 2026, month: 3 } });
    const bonus = await db.payrollRun.create({ data: { periodId: march.id, kind: "BONUS" } });
    const self = await db.employee.findUniqueOrThrow({ where: { code: PAYROLL_CODE } });
    const res = await as("payroll").post(`/payroll-runs/${bonus.id}/bonus`, {
      items: [{ employeeId: self.id, code: "TET", amount: 1_000_000 }],
    });
    assert.equal(res.status, 403);
    assert.equal(res.body.message, "SELF_DECISION");
    const loaded = await as("payroll").post(`/payroll-runs/${bonus.id}/bonus`, {
      items: [{ employeeId: idOf.get(STEADY), code: "TET", amount: 1_000_000 }],
    });
    assert.equal(loaded.status, 201, JSON.stringify(loaded.body));
    const trail = await db.auditLog.findMany({ where: { subjectType: "payroll", subjectId: bonus.id } });
    assert.deepEqual(trail.map((one) => one.action), ["payroll.bonus"], "the load left no trace, or two");
  });

  it("refuses a correction to one's own day, and a day id that is not a number", async () => {
    const self = await db.employee.findUniqueOrThrow({ where: { code: HR_CODE } });
    await db.attendanceDay.create({ data: { employeeId: self.id, date: dateOf(OWN_DAY), state: "ABSENT" } });
    const own = await db.attendanceDay.findFirstOrThrow({ where: { employeeId: self.id, date: dateOf(OWN_DAY) } });
    const res = await as("hr").patch(`/timesheet/${own.id}`, { workedMinutes: 480, reason: "e2e" });
    assert.equal(res.status, 403);
    assert.equal(res.body.message, "SELF_DECISION");
    const junk = await as("hr").patch("/timesheet/not-a-number", { workedMinutes: 480, reason: "e2e" });
    assert.equal(junk.status, 404);

    const theirs = await db.attendanceDay.findFirstOrThrow({ where: { employeeId: idOf.get(ABSENT), date: dateOf("2026-02-03") } });
    const fixed = await as("hr").patch(`/timesheet/${theirs.id}`, { state: "WORKED", workedMinutes: 480, reason: "e2e" });
    assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
    const trail = await db.auditLog.findMany({
      where: { subjectType: "employee", subjectId: String(idOf.get(ABSENT)), action: { startsWith: "timesheet." } },
    });
    assert.deepEqual(trail.map((one) => one.action), ["timesheet.correct"]);
    await db.attendanceDay.update({
      where: { id_date: { id: theirs.id, date: theirs.date } },
      data: { state: "ABSENT", workedMinutes: 0, adjustedById: null, adjustReason: null, adjustedAt: null, measuredMinutes: null },
    });
  });

  it("lists only the people with an exception, finds one by code and exports the filter", async () => {
    const span = `from=2026-02-01&to=2026-02-28&departmentId=${departmentId}`;
    const everyone = await as("admin").get(`/timesheet/summary?${span}`);
    assert.equal(everyone.status, 200);
    assert.deepEqual(
      (everyone.body.rows as { code: string }[]).map((row) => row.code),
      [STEADY, ABSENT, OVERTIME],
    );
    const exceptions = await as("admin").get(`/timesheet/summary?${span}&exceptions=true`);
    assert.deepEqual(
      (exceptions.body.rows as { code: string }[]).map((row) => row.code),
      [ABSENT],
    );
    assert.equal(exceptions.body.total, 1);
    const totals = await as("admin").get(`/timesheet/totals?${span}&exceptions=true`);
    assert.equal(totals.body.people, 1);
    assert.equal(totals.body.absentDays, 1);
    const byCode = await as("admin").get(`/timesheet/summary?${span}&search=${OVERTIME.toLowerCase()}`);
    assert.deepEqual(
      (byCode.body.rows as { code: string }[]).map((row) => row.code),
      [OVERTIME],
    );
    const file = await as("admin").get(`/timesheet/summary/export?${span}&exceptions=true`);
    assert.equal(file.status, 200);
    assert.ok(file.text.includes(ABSENT) && !file.text.includes(STEADY), "the export ignored the filter");
  });

  it("counts a person's own month for their home page", async () => {
    const mine = await as("steady").get("/timesheet/mine?month=2026-01");
    assert.equal(mine.status, 200);
    assert.deepEqual(mine.body, {
      month: "2026-01",
      workedDays: 3,
      lateCount: 1,
      missingPunchDays: 1,
      leaveDays: 0,
      absentDays: 0,
    });
    assert.equal((await as("admin").get("/timesheet/mine?month=2026-01")).status, 404);
    assert.equal((await as("steady").get("/timesheet/mine?month=2026-13")).status, 400);
  });

  it("finds a kiosk by id among a paged fleet and counts the fleet by standing", async () => {
    const found = await as("admin").get(`/devices?search=${DEVICE.toUpperCase()}&take=1`);
    assert.equal(found.status, 200);
    assert.equal(found.body.rows.length, 1);
    assert.equal(found.body.rows[0].id, DEVICE);
    assert.ok("lastSeenAt" in found.body.rows[0]);
    assert.equal(found.body.totalIsExact, true);
    const counts = await as("admin").get("/devices/counts");
    assert.equal(counts.status, 200);
    assert.ok(counts.body.APPROVED >= 1);
    assert.equal(counts.body.online + counts.body.offline, counts.body.APPROVED);
    const revoked = await as("admin").post(`/devices/${DEVICE}/revoke`);
    assert.equal(revoked.status, 201, JSON.stringify(revoked.body));
    const trail = await db.auditLog.findMany({ where: { subjectType: "device", subjectId: DEVICE } });
    assert.deepEqual(trail.map((one) => one.action), ["device.revoke"], "the revoke left no trace, or two");
  });

  it("lets an entity's own policy outrank a newer company-wide one, and checks what a new one holds", async () => {
    await db.payrollPolicy.create({
      data: {
        ...policyFields(WIDE_FROM),
        effectiveFrom: dateOf(WIDE_FROM),
        brackets: { create: BRACKETS.map((band, at) => ({ ordinal: at + 1, upToAmount: band.upToAmount ?? null, rateBp: band.rateBp })) },
      },
    });
    const effective = await as("payroll").get(`/payroll-policies/effective?on=2026-02-28&legalEntityId=${entityId}`);
    assert.equal(effective.status, 200);
    assert.equal(effective.body.id, policyId);
    assert.equal((await as("payroll").get("/payroll-policies/effective?on=not-a-date")).status, 400);

    const disordered = await as("payroll").post("/payroll-policies", {
      ...policyFields("2026-06-01"),
      legalEntityId: entityId,
      brackets: [{ upToAmount: 30_000_000, rateBp: 1000 }, { upToAmount: 10_000_000, rateBp: 500 }, { rateBp: 3500 }],
    });
    assert.equal(disordered.status, 400);
    assert.equal(disordered.body.message, "BRACKETS_OUT_OF_ORDER");
    const taken = await as("payroll").post("/payroll-policies", {
      ...policyFields("2026-01-01"),
      legalEntityId: entityId,
      brackets: BRACKETS,
    });
    assert.equal(taken.status, 409);
    assert.equal(taken.body.message, "POLICY_DATE_TAKEN");
  });
});
