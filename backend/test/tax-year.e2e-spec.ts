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
import { taxOn } from "../src/modules/payroll/calculate.js";
import { PolicyService, asCalcPolicy } from "../src/modules/policy/policy.service.js";

const YEAR = 2026;
const CODE = "NV9401";
const NEIGHBOUR = "NV9402";
const EMAIL = "nv9401@kiosk.local";
const PASSWORD = "kiosk-e2e-password";

// Three months of the same payslip, so every total is a figure that can be
// checked by hand rather than by repeating the code under test.
const MONTHS = [1, 2, 3];
const GROSS = 40_000_000n;
const TAXABLE = 38_000_000n;
const INSURANCE = 4_200_000n;
const RELIEF_SELF = 15_500_000n;
const RELIEF_DEPENDENT = 6_200_000n;
const WITHHELD = 1_100_000n;
const NET = 32_700_000n;

interface Statement {
  employeeId: number;
  year: number;
  months: { month: number; taxWithheld: string }[];
  taxableTotal: string;
  insuranceTotal: string;
  reliefSelfTotal: string;
  reliefDependentTotal: string;
  assessableTotal: string;
  taxDue: string;
  taxWithheld: string;
  difference: string;
}

describe("tax year statement (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let policy: PolicyService;
  let adminToken = "";
  let mineToken = "";
  let employeeId = 0;
  let neighbourId = 0;
  let entityId: string | null = null;

  async function sweep(): Promise<void> {
    await db.user.deleteMany({ where: { email: EMAIL } });
    await db.employee.deleteMany({ where: { code: { in: [CODE, NEIGHBOUR] } } });
    await db.payrollPeriod.deleteMany({ where: { year: YEAR, month: { in: MONTHS } } });
  }

  async function statement(who: number, token: string): Promise<request.Response> {
    return request(http)
      .get(`/tax-year/${who}?year=${YEAR}`)
      .set("Authorization", `Bearer ${token}`);
  }

  before(async () => {
    const env = validateEnv();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    http = app.getHttpServer();
    db = app.get(PrismaService);
    policy = app.get(PolicyService);
    await sweep();

    const asAdmin = await request(http)
      .post("/auth/login")
      .send({ email: "admin@kiosk.local", password: env.SEED_ADMIN_PASSWORD ?? "" });
    assert.equal(asAdmin.status, 200, "admin could not sign in");
    adminToken = asAdmin.body.accessToken;

    const template = await db.employee.findFirstOrThrow({
      where: { active: true, legalEntityId: { not: null } },
    });
    entityId = template.legalEntityId;
    for (const code of [CODE, NEIGHBOUR]) {
      const made = await db.employee.create({
        data: {
          code,
          fullName: `Thử quyết toán ${code}`,
          active: true,
          departmentId: template.departmentId,
          legalEntityId: template.legalEntityId,
        },
      });
      if (code === CODE) {
        employeeId = made.id;
      } else {
        neighbourId = made.id;
      }
    }

    const inForce = await policy.effectiveAt(new Date(Date.UTC(YEAR, 11, 31)), entityId);
    for (const month of MONTHS) {
      const period = await db.payrollPeriod.create({
        data: {
          year: YEAR,
          month,
          startDate: new Date(Date.UTC(YEAR, month - 1, 1)),
          endDate: new Date(Date.UTC(YEAR, month, 0)),
        },
      });
      const run = await db.payrollRun.create({
        data: { periodId: period.id, kind: "REGULAR", state: "DONE" },
      });
      // The third month stays a draft: a figure nobody issued is not income.
      const state = month === MONTHS[MONTHS.length - 1] ? "DRAFT" : "ISSUED";
      const slip = await db.payslip.create({
        data: {
          runId: run.id,
          periodId: period.id,
          employeeId,
          policyId: inForce.id,
          state,
          grossPay: GROSS.toString(),
          taxableIncome: TAXABLE.toString(),
          insuranceEmployee: INSURANCE.toString(),
          personalIncomeTax: WITHHELD.toString(),
          netPay: NET.toString(),
        },
      });
      await db.payslipLine.createMany({
        data: [
          { payslipId: slip.id, ordinal: 1, kind: "INFO", code: "DEDUCT_SELF", amount: RELIEF_SELF.toString() },
          { payslipId: slip.id, ordinal: 2, kind: "INFO", code: "DEDUCT_DEPENDENT", amount: RELIEF_DEPENDENT.toString() },
          { payslipId: slip.id, ordinal: 3, kind: "DEDUCTION", code: "PIT", amount: WITHHELD.toString() },
          { payslipId: slip.id, ordinal: 4, kind: "DEDUCTION", code: "BHXH", amount: INSURANCE.toString() },
        ],
      });
    }

    await db.user.create({
      data: {
        email: EMAIL,
        passwordHash: await hashPassword(PASSWORD),
        role: "EMPLOYEE",
        employeeId,
      },
    });
    const asMe = await request(http).post("/auth/login").send({ email: EMAIL, password: PASSWORD });
    assert.equal(asMe.status, 200, "the employee account could not sign in");
    mineToken = asMe.body.accessToken;
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("counts the issued months and leaves the draft out", async () => {
    const res = await statement(employeeId, adminToken);
    assert.equal(res.status, 200);
    const held = res.body as Statement;
    assert.equal(held.months.length, MONTHS.length - 1);
    assert.equal(held.taxableTotal, (TAXABLE * 2n).toString());
    assert.equal(held.insuranceTotal, (INSURANCE * 2n).toString());
    assert.equal(held.taxWithheld, (WITHHELD * 2n).toString());
  });

  it("reads the relief back from the payslip lines rather than the policy", async () => {
    const held = (await statement(employeeId, adminToken)).body as Statement;
    assert.equal(held.reliefSelfTotal, (RELIEF_SELF * 2n).toString());
    assert.equal(held.reliefDependentTotal, (RELIEF_DEPENDENT * 2n).toString());
  });

  it("settles the year on one band table and names the gap", async () => {
    const held = (await statement(employeeId, adminToken)).body as Statement;
    const assessable = (TAXABLE - INSURANCE - RELIEF_SELF - RELIEF_DEPENDENT) * 2n;
    assert.equal(held.assessableTotal, assessable.toString());

    const inForce = await policy.effectiveAt(new Date(Date.UTC(YEAR, 11, 31)), entityId);
    const due = taxOn(assessable, asCalcPolicy(inForce).brackets);
    assert.equal(held.taxDue, due.toString());
    assert.equal(held.difference, (due - WITHHELD * 2n).toString());
    assert.notEqual(held.difference, "0", "a year settled on one table rarely matches the monthly sum");
  });

  it("lets a person read their own year", async () => {
    const res = await statement(employeeId, mineToken);
    assert.equal(res.status, 200);
    assert.equal((res.body as Statement).employeeId, employeeId);
  });

  it("does not let a person read somebody else's year", async () => {
    const res = await statement(neighbourId, mineToken);
    assert.equal(res.status, 404, "a stranger's year is not found, not forbidden");
  });
});
