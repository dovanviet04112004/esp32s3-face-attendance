import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { PayrollService } from "../src/modules/payroll/payroll.service.js";
import { PolicyService } from "../src/modules/policy/policy.service.js";
import { paidLeaveType } from "./fixtures.js";

const YEAR = 2027;
const MONTH = 6;
const LEAVER = "NV9901";
const STAYER = "NV9902";
const LEFT_EARLIER = "NV9903";
const BASE_SALARY = 26_000_000n;
const UNUSED_DAYS = 4;
const SEVERANCE = 13_000_000n;
const ASSET_OFFSET = 2_000_000n;
const ADVANCE = 5_000_000n;
// Whole days on the timesheet, so gross pay is a real figure rather than the
// zero an empty timesheet produces.
const WORKED_DAYS = 14;
const MINUTES_PER_DAY = 480;

interface SettlementRow {
  employeeId: number;
  code: string;
  tenureMonths: number;
  halfMonthPay: string;
  unusedLeaveDays: number;
  leavePayout: string;
  assetsHeld: { code: string; name: string }[];
}

describe("final settlement (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let payroll: PayrollService;
  let policy: PolicyService;
  let token = "";
  let periodId = "";
  let regularRunId = "";
  let settlementRunId = "";
  let leaverId = 0;
  let stayerId = 0;
  let earlierId = 0;
  let entityId: string | null = null;
  let dailyPay = 0n;

  const start = new Date(Date.UTC(YEAR, MONTH - 1, 1));
  const end = new Date(Date.UTC(YEAR, MONTH, 0));

  async function sweep(): Promise<void> {
    await db.employee.deleteMany({ where: { code: { in: [LEAVER, STAYER, LEFT_EARLIER] } } });
    await db.payrollPeriod.deleteMany({ where: { year: YEAR, month: MONTH } });
    await db.asset.deleteMany({ where: { code: "E2E-LAPTOP-9901" } });
  }

  async function sheet(): Promise<SettlementRow[]> {
    const res = await request(http)
      .get(`/payroll-runs/${settlementRunId}/settlement`)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.rows as SettlementRow[];
  }

  function slipOf(runId: string, employeeId: number) {
    return db.payslip.findFirst({ where: { runId, employeeId }, include: { lines: true } });
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
    policy = app.get(PolicyService);
    await sweep();

    const asAdmin = await request(http)
      .post("/auth/login")
      .send({ email: "admin@kiosk.local", password: env.SEED_ADMIN_PASSWORD ?? "" });
    assert.equal(asAdmin.status, 200, "admin could not sign in");
    token = asAdmin.body.accessToken;

    const template = await db.employee.findFirstOrThrow({
      where: { active: true, legalEntityId: { not: null } },
    });
    entityId = template.legalEntityId;

    const people = [
      { code: LEAVER, active: false, leaveDate: new Date(Date.UTC(YEAR, MONTH - 1, 20)) },
      { code: STAYER, active: true, leaveDate: null },
      { code: LEFT_EARLIER, active: false, leaveDate: new Date(Date.UTC(YEAR, MONTH - 2, 15)) },
    ];
    for (const one of people) {
      const made = await db.employee.create({
        data: {
          code: one.code,
          fullName: `Thử chốt cuối ${one.code}`,
          active: one.active,
          leaveDate: one.leaveDate,
          hireDate: new Date(Date.UTC(YEAR - 3, MONTH - 1, 1)),
          departmentId: template.departmentId,
          legalEntityId: template.legalEntityId,
        },
      });
      if (one.code === LEAVER) {
        leaverId = made.id;
      } else if (one.code === STAYER) {
        stayerId = made.id;
      } else {
        earlierId = made.id;
      }
      await db.compensationRecord.create({
        data: {
          employeeId: made.id,
          effectiveFrom: new Date(Date.UTC(YEAR - 3, MONTH - 1, 1)),
          baseSalary: BASE_SALARY.toString(),
          insuranceSalary: BASE_SALARY.toString(),
        },
      });
    }

    const annual = await paidLeaveType(db);
    await db.leaveBalance.create({
      data: {
        employeeId: leaverId,
        leaveTypeId: annual.id,
        year: YEAR,
        entitled: UNUSED_DAYS,
      },
    });
    await db.asset.create({
      data: {
        code: "E2E-LAPTOP-9901",
        name: "Laptop thử",
        kind: "LAPTOP",
        state: "ISSUED",
        holderId: leaverId,
      },
    });
    await db.salaryAdvance.create({
      data: { employeeId: leaverId, amount: ADVANCE.toString(), reason: "e2e", state: "PAID" },
    });

    for (const who of [leaverId, stayerId]) {
      await db.attendanceDay.createMany({
        data: Array.from({ length: WORKED_DAYS }, (_, at) => ({
          employeeId: who,
          date: new Date(Date.UTC(YEAR, MONTH - 1, at + 1)),
          state: "WORKED" as const,
          workedMinutes: MINUTES_PER_DAY,
          punchCount: 2,
        })),
      });
    }

    const period = await db.payrollPeriod.create({
      data: { year: YEAR, month: MONTH, startDate: start, endDate: end, legalEntityId: entityId },
    });
    periodId = period.id;
    const inForce = await policy.effectiveAt(end, entityId);
    dailyPay =
      (BASE_SALARY * 100n * 2n + BigInt(Number(inForce.standardDaysPerMonth) * 100)) /
      (BigInt(Number(inForce.standardDaysPerMonth) * 100) * 2n);

    const regular = await db.payrollRun.create({
      data: { periodId, kind: "REGULAR", state: "DRAFT" },
    });
    regularRunId = regular.id;
    await payroll.runNow(regularRunId);

    const settlement = await db.payrollRun.create({
      data: { periodId, kind: "FINAL_SETTLEMENT", state: "DRAFT" },
    });
    settlementRunId = settlement.id;
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("pays a mid-month leaver on the regular run", async () => {
    const paid = await slipOf(regularRunId, leaverId);
    assert.ok(paid, "the leaver has no regular payslip at all");
    const stayed = await slipOf(regularRunId, stayerId);
    assert.ok(stayed, "the stayer went missing");
    assert.equal(
      paid.grossPay.toFixed(0),
      stayed.grossPay.toFixed(0),
      "the same fourteen days pay the same whether or not somebody stayed",
    );
    assert.ok(Number(paid.grossPay) > 0, "the leaver was paid nothing for the days worked");
  });

  it("recovers the outstanding advance on that same payslip", async () => {
    const paid = await slipOf(regularRunId, leaverId);
    const line = paid?.lines.find((row) => row.code === "ADVANCE");
    assert.ok(line, "the advance was never deducted");
    assert.equal(line.amount.toFixed(0), ADVANCE.toString());
  });

  it("leaves out somebody who left before the period began", async () => {
    assert.equal(await slipOf(regularRunId, earlierId), null);
    assert.ok(await slipOf(regularRunId, stayerId), "the stayer went missing");
  });

  it("offers tenure, half a month and the assets still held", async () => {
    const rows = await sheet();
    assert.equal(rows.length, 1, "only the leaver of this period belongs on the sheet");
    const row = rows[0];
    assert.equal(row.code, LEAVER);
    assert.equal(row.tenureMonths, 36);
    assert.equal(row.halfMonthPay, (BASE_SALARY / 2n).toString());
    assert.equal(row.unusedLeaveDays, UNUSED_DAYS);
    assert.equal(row.leavePayout, (dailyPay * BigInt(UNUSED_DAYS)).toString());
    assert.deepEqual(
      row.assetsHeld.map((one) => one.code),
      ["E2E-LAPTOP-9901"],
    );
  });

  it("refuses a typed figure for somebody who did not leave this period", async () => {
    const res = await request(http)
      .post(`/payroll-runs/${settlementRunId}/settlement`)
      .set("Authorization", `Bearer ${token}`)
      .send({ items: [{ employeeId: stayerId, kind: "SEVERANCE", amount: 1_000_000 }] });
    assert.equal(res.status, 400);
    assert.match(JSON.stringify(res.body), /EMPLOYEE_DID_NOT_LEAVE_THIS_PERIOD/);
  });

  it("treats severance as exempt and an offset as a deduction", async () => {
    const loaded = await request(http)
      .post(`/payroll-runs/${settlementRunId}/settlement`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        items: [
          { employeeId: leaverId, kind: "SEVERANCE", amount: Number(SEVERANCE) },
          { employeeId: leaverId, kind: "ASSET_OFFSET", amount: Number(ASSET_OFFSET) },
        ],
      });
    assert.equal(loaded.status, 201, JSON.stringify(loaded.body));

    await payroll.runNow(settlementRunId);
    const slip = await slipOf(settlementRunId, leaverId);
    assert.ok(slip, "the settlement produced no payslip");

    const payout = dailyPay * BigInt(UNUSED_DAYS);
    assert.equal(slip.grossPay.toFixed(0), (payout + SEVERANCE).toString());
    // Only the leave payout is taxable: statutory severance is exempt.
    assert.equal(slip.taxableIncome.toFixed(0), payout.toString());

    const codes = slip.lines.map((row) => row.code).sort();
    assert.ok(codes.includes("LEAVE_PAYOUT"));
    assert.ok(codes.includes("SEVERANCE"));
    assert.ok(codes.includes("ASSET_OFFSET"));

    const offset = slip.lines.find((row) => row.code === "ASSET_OFFSET");
    assert.equal(offset?.kind, "DEDUCTION");
    const tax = BigInt(slip.personalIncomeTax.toFixed(0));
    assert.equal(
      slip.netPay.toFixed(0),
      (payout + SEVERANCE - ASSET_OFFSET - tax).toString(),
      "net is gross less the offset and the tax",
    );
  });

  it("runs twice for the same figures rather than doubling them", async () => {
    await payroll.runNow(settlementRunId);
    const slips = await db.payslip.findMany({ where: { runId: settlementRunId } });
    assert.equal(slips.length, 1);
    const payout = dailyPay * BigInt(UNUSED_DAYS);
    assert.equal(slips[0].grossPay.toFixed(0), (payout + SEVERANCE).toString());
  });
});
