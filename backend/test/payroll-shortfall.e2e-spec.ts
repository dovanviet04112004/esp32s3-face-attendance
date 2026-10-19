import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { BYTE_ORDER_MARK } from "../src/common/csv.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { PayrollService } from "../src/modules/payroll/payroll.service.js";
import { cellsOf, signIn } from "./fixtures.js";

// An entity of its own, so every run and lock here reaches only the people this suite made.
const ENTITY_CODE = "E2E-PAYS";
const DEPARTMENT_CODE = "E2E-PAYS-D";
const SHORT = "NV9S01";
const UNPRICED = "NV9S02";
const LEAVER = "NV9S03";
const CODES = [SHORT, UNPRICED, LEAVER];
const BASE = 26_000_000;
const ONE_DAY = 1_000_000;
const INSURANCE = 2_730_000;
const SHORTFALL = INSURANCE - ONE_DAY;
const FULL_MONTH = 20_000_000;
const APRIL_TAX = 88_500;
const LOCK_NOTE = "Hai phiếu âm chuyển sang kỳ sau, một người chưa có hồ sơ lương";

const BRACKETS = [
  { upToAmount: 10_000_000, rateBp: 500 },
  { upToAmount: 30_000_000, rateBp: 1000 },
  { upToAmount: 60_000_000, rateBp: 2000 },
  { upToAmount: 100_000_000, rateBp: 3000 },
  { rateBp: 3500 },
];

const POLICY = {
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

// One day worked of three, too few absences to stop the contributions.
const MARCH_DAYS = [
  { date: "2026-03-02", state: "WORKED" as const, workedMinutes: 480, punchCount: 2 },
  { date: "2026-03-03", state: "ABSENT" as const },
  { date: "2026-03-04", state: "ABSENT" as const },
];

// Twenty weekdays of April 2026, a full month's pay at 26 standard days.
const APRIL_DAYS = [1, 2, 3, 6, 7, 8, 9, 10, 13, 14, 15, 16, 17, 20, 21, 22, 23, 24, 27, 28].map(
  (day) => `2026-04-${String(day).padStart(2, "0")}`,
);

function dateOf(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

function rowsOf(text: string): string[][] {
  return text.slice(BYTE_ORDER_MARK.length).split("\r\n").map(cellsOf);
}

describe("a payslip that comes short (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let payroll: PayrollService;
  const token = { admin: "", payroll: "" };
  let entityId = "";
  let departmentId = "";
  const idOf = new Map<string, number>();
  let marchId = "";
  let aprilId = "";

  async function sweep(): Promise<void> {
    await db.payrollPeriod.deleteMany({ where: { legalEntity: { code: ENTITY_CODE } } });
    await db.employee.deleteMany({ where: { code: { in: CODES } } });
    await db.department.deleteMany({ where: { code: DEPARTMENT_CODE } });
    await db.legalEntity.deleteMany({ where: { code: ENTITY_CODE } });
  }

  function as(who: keyof typeof token) {
    return {
      get: (path: string) => request(http).get(path).set("Authorization", `Bearer ${token[who]}`),
      post: (path: string, body?: object) =>
        request(http).post(path).set("Authorization", `Bearer ${token[who]}`).send(body ?? {}),
    };
  }

  async function regularRun(periodId: string) {
    const run = await db.payrollRun.create({ data: { periodId, kind: "REGULAR" } });
    const done = await payroll.runNow(run.id);
    assert.equal(done.state, "DONE", JSON.stringify(done));
    const slips = await db.payslip.findMany({
      where: { runId: run.id },
      include: { lines: { orderBy: { ordinal: "asc" } } },
    });
    const slipOf = (code: string) => slips.find((slip) => slip.employeeId === idOf.get(code));
    return { done, slipOf };
  }

  before(async () => {
    const env = validateEnv();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    http = app.getHttpServer();
    db = app.get(PrismaService);
    payroll = app.get(PayrollService);
    await sweep();

    const password = env.SEED_ADMIN_PASSWORD ?? "";
    token.admin = await signIn(http, "admin@kiosk.local", password);
    token.payroll = await signIn(http, "payroll@kiosk.local", password);

    const entity = await db.legalEntity.create({ data: { code: ENTITY_CODE, name: "Pháp nhân thử phiếu âm" } });
    entityId = entity.id;
    const department = await db.department.create({
      data: { legalEntityId: entityId, code: DEPARTMENT_CODE, name: "Phòng thử phiếu âm" },
    });
    departmentId = department.id;
    await db.payrollPolicy.create({
      data: {
        ...POLICY,
        effectiveFrom: dateOf("2026-01-01"),
        legalEntityId: entityId,
        brackets: {
          create: BRACKETS.map((band, at) => ({ ordinal: at + 1, upToAmount: band.upToAmount ?? null, rateBp: band.rateBp })),
        },
      },
    });
    for (const code of CODES) {
      const leaving = code === LEAVER;
      const made = await db.employee.create({
        data: {
          code,
          fullName: `Thử phiếu âm ${code}`,
          active: !leaving,
          leaveDate: leaving ? dateOf("2026-03-04") : null,
          legalEntityId: entityId,
          departmentId,
          hireDate: dateOf("2025-01-01"),
        },
      });
      idOf.set(code, made.id);
      if (code !== UNPRICED) {
        await db.compensationRecord.create({
          data: { employeeId: made.id, effectiveFrom: dateOf("2025-01-01"), baseSalary: BASE, insuranceSalary: BASE },
        });
      }
    }
    const march = [SHORT, LEAVER].flatMap((code) =>
      MARCH_DAYS.map(({ date, ...day }) => ({ employeeId: idOf.get(code) as number, date: dateOf(date), ...day })),
    );
    const april = APRIL_DAYS.map((day) => ({
      employeeId: idOf.get(SHORT) as number,
      date: dateOf(day),
      state: "WORKED" as const,
      workedMinutes: 480,
      punchCount: 2,
    }));
    await db.attendanceDay.createMany({ data: [...march, ...april] });
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("pays nothing below zero and carries the rest, and runs only the people with a pay record", async () => {
    const opened = await as("payroll").post("/payroll-periods", { legalEntityId: entityId, year: 2026, month: 3 });
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
    marchId = opened.body.id;

    const { done, slipOf } = await regularRun(marchId);
    assert.equal(done.employeeCount, 2, "someone without a pay record was taken into the run");
    assert.equal(done.failedCount, 0, "someone without a pay record was counted as a failure");
    const short = slipOf(SHORT);
    assert.ok(short, "the short payslip is missing");
    assert.equal(short.grossPay.toNumber(), ONE_DAY);
    assert.equal(short.netPay.toNumber(), 0);
    assert.equal(short.deductionsTotal.toNumber(), ONE_DAY);
    const carried = short.lines.find((line) => line.code === "CARRY_OUT");
    assert.ok(carried, "the shortfall has no line of its own");
    assert.equal(carried.kind, "INFO");
    assert.equal(carried.amount.toNumber(), SHORTFALL);
  });

  it("keeps a leaver's shortfall on the slip, as no next period takes it", async () => {
    const slip = await db.payslip.findFirstOrThrow({
      where: { periodId: marchId, employeeId: idOf.get(LEAVER) },
      include: { lines: true },
    });
    assert.equal(slip.netPay.toNumber(), -SHORTFALL);
    assert.equal(slip.deductionsTotal.toNumber(), INSURANCE);
    assert.ok(!slip.lines.some((line) => line.code === "CARRY_OUT"), "a leaver's shortfall was carried");
  });

  it("names the short payslips on the checklist and locks over them only with a reason", async () => {
    const checklist = await as("payroll").get(`/payroll-periods/${marchId}/checklist`);
    assert.equal(checklist.status, 200, JSON.stringify(checklist.body));
    const countOf = (code: string) => checklist.body.find((item: { code: string }) => item.code === code)?.count;
    assert.equal(countOf("NEGATIVE_NET"), 2);
    assert.equal(countOf("NO_COMPENSATION"), 1);

    const refused = await as("payroll").post(`/payroll-periods/${marchId}/lock`, {});
    assert.equal(refused.status, 400);
    assert.equal(refused.body.message, "CHECKLIST_NOT_CLEAR");
    for (const bare of [{ acceptOpenItems: true }, { acceptOpenItems: true, note: "   " }]) {
      const unexplained = await as("payroll").post(`/payroll-periods/${marchId}/lock`, bare);
      assert.deepEqual([unexplained.status, unexplained.body.message], [400, "LOCK_NOTE_REQUIRED"], JSON.stringify(bare));
    }
    const locked = await as("payroll").post(`/payroll-periods/${marchId}/lock`, { acceptOpenItems: true, note: LOCK_NOTE });
    assert.ok(locked.status < 300, JSON.stringify(locked.body));
    const kept = await db.payrollPeriod.findUniqueOrThrow({ where: { id: marchId } });
    assert.equal(kept.lockNote, LOCK_NOTE, "the lock kept no reason for the items it accepted");

    const owed = await db.retroAdjustment.findMany({ where: { employeeId: { in: [...idOf.values()] } } });
    assert.equal(owed.length, 1, "the lock carried other than the one short slip that has a next period");
    assert.equal(owed[0].employeeId, idOf.get(SHORT));
    assert.equal(owed[0].code, "CARRY");
    assert.equal(owed[0].state, "PENDING");
    assert.equal(owed[0].reason, "NEGATIVE_NET");
    assert.equal(owed[0].sourcePeriodId, marchId);
    assert.equal(owed[0].amount.toNumber(), SHORTFALL);
  });

  it("leaves the short payslips out of the bank file and shows the carry in the ledger", async () => {
    const bank = await as("admin").get(`/payroll-periods/${marchId}/export?kind=bank`);
    assert.equal(bank.status, 200, bank.text);
    const paid = rowsOf(bank.text).slice(1);
    assert.ok(!paid.some((row) => row[0] === SHORT || row[0] === LEAVER), "the bank file pays a slip that came short");
    assert.ok(!paid.some((row) => row.some((cell) => cell.startsWith("-"))), "the bank file holds a negative amount");

    const ledger = await as("admin").get(`/payroll-periods/${marchId}/export?kind=ledger`);
    assert.equal(ledger.status, 200, ledger.text);
    const [header, ...rows] = rowsOf(ledger.text);
    const cellOf = (code: string, column: string) => rows.find((row) => row[0] === code)?.[header.indexOf(column)];
    assert.equal(cellOf(SHORT, "net"), "0");
    assert.equal(cellOf(SHORT, "carried"), String(SHORTFALL));
    assert.equal(cellOf(LEAVER, "net"), String(-SHORTFALL));
    assert.equal(cellOf(LEAVER, "carried"), "0");
  });

  it("takes the carry off the next period after tax, and spends it at that lock", async () => {
    const opened = await as("payroll").post("/payroll-periods", { legalEntityId: entityId, year: 2026, month: 4 });
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
    aprilId = opened.body.id;

    const { done, slipOf } = await regularRun(aprilId);
    assert.equal(done.employeeCount, 1, "someone who left in March was taken into April");
    const slip = slipOf(SHORT);
    assert.ok(slip, "the April payslip is missing");
    const carried = slip.lines.find((line) => line.code === "RETRO_CARRY");
    assert.ok(carried, "the carry never reached the next payslip");
    assert.equal(carried.kind, "DEDUCTION");
    assert.equal(carried.amount.toNumber(), SHORTFALL);
    assert.equal(slip.taxableIncome.toNumber(), FULL_MONTH, "the carry lowered the taxable income");
    assert.equal(slip.personalIncomeTax.toNumber(), APRIL_TAX);
    assert.equal(slip.netPay.toNumber(), FULL_MONTH - INSURANCE - APRIL_TAX - SHORTFALL);
    assert.ok(!slip.lines.some((line) => line.code === "CARRY_OUT"), "a payslip in credit carried something");

    const locked = await as("payroll").post(`/payroll-periods/${aprilId}/lock`, { acceptOpenItems: true, note: "e2e" });
    assert.ok(locked.status < 300, JSON.stringify(locked.body));
    const owed = await db.retroAdjustment.findMany({ where: { employeeId: { in: [...idOf.values()] } } });
    assert.equal(owed.length, 1, "the lock carried a shortfall that never was");
    assert.equal(owed[0].state, "APPLIED");
    assert.equal(owed[0].appliedPeriodId, aprilId);

    const bank = await as("admin").get(`/payroll-periods/${aprilId}/export?kind=bank`);
    assert.equal(bank.status, 200, bank.text);
    const [header, ...rows] = rowsOf(bank.text);
    const paid = rows.find((row) => row[0] === SHORT);
    assert.ok(paid, "the bank file left out a slip in credit");
    assert.equal(paid[header.indexOf("amount")], slip.netPay.toFixed(0));
  });
});
