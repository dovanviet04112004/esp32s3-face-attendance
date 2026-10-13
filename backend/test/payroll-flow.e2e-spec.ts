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
import { PayrollService } from "../src/modules/payroll/payroll.service.js";
import { signIn } from "./fixtures.js";

// Two entities of this suite's own, so a person can move between them and every lock reaches only them.
const HOME_CODE = "E2E-FLOW-A";
const AWAY_CODE = "E2E-FLOW-B";
const MOVER = "NV9F01";
const STAYER = "NV9F02";
const NEWCOMER = "NV9F03";
const STRAY = "NV9F09";
const CODES = [MOVER, STAYER, NEWCOMER, STRAY];
const YEAR = 2026;
const BASE = 20_000_000;
const ADVANCE = 1_000_000;
const SETTLE_MS = 30_000;
const POLL_MS = 200;

const BRACKETS = [
  { upToAmount: 10_000_000, rateBp: 500 },
  { upToAmount: 30_000_000, rateBp: 1000 },
  { upToAmount: 60_000_000, rateBp: 2000 },
  { upToAmount: 100_000_000, rateBp: 3000 },
  { upToAmount: null, rateBp: 3500 },
];

function dateOf(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

function policyOf(legalEntityId: string) {
  return {
    legalEntityId,
    effectiveFrom: dateOf("2026-01-01"),
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
    brackets: { create: BRACKETS.map((band, at) => ({ ordinal: at + 1, ...band })) },
  };
}

describe("the payroll run flow, guarded on its rows (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let payroll: PayrollService;
  const token = { admin: "", payroll: "" };
  const idOf = new Map<string, number>();
  let homeId = "";
  let awayId = "";
  let homePolicyId = "";
  let aprilHome = "";
  let regularId = "";
  let bonusId = "";

  async function sweep(): Promise<void> {
    const entities = { legalEntity: { code: { in: [HOME_CODE, AWAY_CODE] } } };
    await db.payrollPeriod.deleteMany({ where: entities });
    await db.salaryAdvance.deleteMany({ where: { employee: { code: { in: CODES } } } });
    await db.employee.deleteMany({ where: { code: { in: CODES } } });
    await db.legalEntity.deleteMany({ where: { code: { in: [HOME_CODE, AWAY_CODE] } } });
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

  async function hire(code: string, legalEntityId: string): Promise<number> {
    const made = await db.employee.create({
      data: { code, fullName: `Thử luồng lương ${code}`, active: true, legalEntityId, hireDate: dateOf("2025-01-01") },
    });
    await db.compensationRecord.create({
      data: { employeeId: made.id, effectiveFrom: dateOf("2025-01-01"), baseSalary: BASE, insuranceSalary: BASE },
    });
    idOf.set(code, made.id);
    return made.id;
  }

  async function settled(runId: string): Promise<string> {
    let state = "RUNNING";
    for (let waited = 0; waited < SETTLE_MS && state === "RUNNING"; waited += POLL_MS) {
      await sleep(POLL_MS);
      state = (await db.payrollRun.findUniqueOrThrow({ where: { id: runId } })).state;
    }
    return state;
  }

  async function quiet(periodId: string): Promise<void> {
    let running = 1;
    for (let waited = 0; waited < SETTLE_MS && running > 0; waited += POLL_MS) {
      running = await db.payrollRun.count({ where: { periodId, state: "RUNNING" } });
      if (running > 0) {
        await sleep(POLL_MS);
      }
    }
  }

  async function countOf(periodId: string, code: string): Promise<number | undefined> {
    const items = await as("payroll").get(`/payroll-periods/${periodId}/checklist`);
    assert.equal(items.status, 200, JSON.stringify(items.body));
    return (items.body as { code: string; count: number }[]).find((one) => one.code === code)?.count;
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

    homeId = (await db.legalEntity.create({ data: { code: HOME_CODE, name: "Pháp nhân luồng A" } })).id;
    awayId = (await db.legalEntity.create({ data: { code: AWAY_CODE, name: "Pháp nhân luồng B" } })).id;
    homePolicyId = (await db.payrollPolicy.create({ data: policyOf(homeId) })).id;
    await db.payrollPolicy.create({ data: policyOf(awayId) });
    await hire(MOVER, homeId);
    await hire(STAYER, homeId);
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("opens no period without an entity while there are several", async () => {
    const wide = await as("payroll").post("/payroll-periods", { year: YEAR, month: 4 });
    assert.equal(wide.status, 400, JSON.stringify(wide.body));
    assert.equal(wide.body.message, "LEGAL_ENTITY_REQUIRED");
  });

  it("keeps one period open per entity, however close two presses come", async () => {
    const april = await as("payroll").post("/payroll-periods", { legalEntityId: homeId, year: YEAR, month: 4 });
    assert.equal(april.status, 201, JSON.stringify(april.body));
    aprilHome = april.body.id;
    const may = await as("payroll").post("/payroll-periods", { legalEntityId: homeId, year: YEAR, month: 5 });
    assert.equal(may.status, 409, "a second open period of one entity was accepted");
    assert.equal(may.body.message, "PERIOD_STILL_OPEN");

    const presses = await Promise.all(
      [8, 9].map((month) => as("payroll").post("/payroll-periods", { legalEntityId: awayId, year: YEAR, month })),
    );
    assert.deepEqual(
      presses.map((one) => one.status).sort(),
      [201, 409],
      JSON.stringify(presses.map((one) => one.body)),
    );
    assert.equal(presses.find((one) => one.status === 409)?.body.message, "PERIOD_STILL_OPEN");
    await db.payrollPeriod.deleteMany({ where: { legalEntityId: awayId } });
  });

  it("runs one run of a period at a time", async () => {
    const [one, two] = await Promise.all(
      [1, 2].map(() => db.payrollRun.create({ data: { periodId: aprilHome, kind: "REGULAR" } })),
    );
    const presses = await Promise.all([one, two].map((run) => as("payroll").post(`/payroll-runs/${run.id}/execute`)));
    assert.deepEqual(
      presses.map((press) => press.status).sort(),
      [201, 409],
      JSON.stringify(presses.map((press) => press.body)),
    );
    const winner = presses[0].status === 201 ? one : two;
    const loser = winner === one ? two : one;
    assert.equal(presses.find((press) => press.status === 409)?.body.message, "PERIOD_RUN_IN_PROGRESS");
    assert.equal(await settled(winner.id), "DONE");
    regularId = winner.id;

    const dropped = await as("payroll").post(`/payroll-runs/${loser.id}/discard`);
    assert.equal(dropped.status, 201, JSON.stringify(dropped.body));
    assert.equal(dropped.body.state, "DISCARDED");
  });

  it("sends a finished bonus back to draft when the regular run under it is rerun", async () => {
    const regular = await db.payrollRun.create({ data: { periodId: aprilHome, kind: "REGULAR" } });
    assert.equal((await payroll.runNow(regular.id)).state, "DONE");
    regularId = regular.id;
    const bonus = await db.payrollRun.create({ data: { periodId: aprilHome, kind: "BONUS" } });
    bonusId = bonus.id;
    const loaded = await as("payroll").post(`/payroll-runs/${bonusId}/bonus`, {
      items: [{ employeeId: idOf.get(STAYER), code: "TET", amount: 5_000_000 }],
    });
    assert.equal(loaded.status, 201, JSON.stringify(loaded.body));
    assert.equal((await payroll.runNow(bonusId)).state, "DONE");
    assert.equal(await db.payslip.count({ where: { runId: bonusId } }), 1);

    await payroll.runNow(regularId);
    const stale = await db.payrollRun.findUniqueOrThrow({ where: { id: bonusId } });
    assert.deepEqual([stale.state, stale.failure], ["DRAFT", "RUN_BASE_CHANGED"], "a bonus kept the tax base of a replaced run");
    assert.equal(await db.payslip.count({ where: { runId: bonusId } }), 0, "a stale bonus kept its payslips");
    assert.equal(await db.bonusItem.count({ where: { runId: bonusId } }), 1, "the bonus lost what it pays");

    const refused = await as("payroll").post(`/payroll-periods/${aprilHome}/lock`, { acceptOpenItems: true });
    assert.equal(refused.status, 409, JSON.stringify(refused.body));
    assert.equal(refused.body.message, "RUN_BASE_CHANGED");
    assert.equal((await payroll.runNow(bonusId)).state, "DONE");
  });

  it("locks only when every run is finished or discarded, and keeps a discarded run down", async () => {
    await quiet(aprilHome);
    const steadyId = idOf.get(STAYER) as number;
    const failed = await db.payrollRun.create({ data: { periodId: aprilHome, kind: "REGULAR", state: "FAILED" } });
    const leftover = await db.payslip.create({
      data: { runId: failed.id, periodId: aprilHome, employeeId: steadyId, policyId: homePolicyId, grossPay: 1, netPay: 1 },
    });
    const behind = await as("payroll").post(`/payroll-periods/${aprilHome}/lock`, { acceptOpenItems: true });
    assert.equal(behind.status, 409, "a lock issued an older run over the newest one that failed");
    assert.equal(behind.body.message, "PERIOD_RUNS_UNFINISHED");

    const dropped = await as("payroll").post(`/payroll-runs/${failed.id}/discard`);
    assert.equal(dropped.status, 201, JSON.stringify(dropped.body));
    assert.equal(await db.payslip.count({ where: { id: leftover.id } }), 0, "a discarded run left a payslip behind");
    const again = await as("payroll").post(`/payroll-runs/${failed.id}/execute`);
    assert.equal(again.status, 409);
    assert.equal(again.body.message, "RUN_DISCARDED");

    const idle = await db.payrollRun.create({ data: { periodId: aprilHome, kind: "BONUS" } });
    const unpaid = await as("payroll").post(`/payroll-periods/${aprilHome}/lock`, { acceptOpenItems: true });
    assert.equal(unpaid.status, 409, "a lock left a bonus run in draft unpaid without a word");
    assert.equal(unpaid.body.message, "PERIOD_RUNS_UNFINISHED");
    assert.equal((await as("payroll").post(`/payroll-runs/${idle.id}/discard`)).status, 201);

    const busy = await db.payrollRun.create({ data: { periodId: aprilHome, kind: "REGULAR", state: "RUNNING" } });
    const midway = await as("payroll").post(`/payroll-runs/${busy.id}/discard`);
    assert.equal(midway.status, 400);
    assert.equal(midway.body.message, "RUN_ALREADY_RUNNING");
    await db.payrollRun.update({ where: { id: busy.id }, data: { state: "FAILED" } });
    assert.equal((await as("payroll").post(`/payroll-runs/${busy.id}/discard`)).status, 201);

    const locked = await as("payroll").post(`/payroll-periods/${aprilHome}/lock`, { acceptOpenItems: true });
    assert.equal(locked.status, 201, JSON.stringify(locked.body));
    const issued = await db.payslip.findMany({ where: { periodId: aprilHome, state: { not: "DRAFT" } }, select: { runId: true } });
    assert.deepEqual(
      [...new Set(issued.map((one) => one.runId))].sort(),
      [bonusId, regularId].sort(),
      "the lock issued a run other than the newest regular one and the bonus",
    );
    const closed = await as("payroll").post(`/payroll-runs/${regularId}/discard`);
    assert.equal(closed.status, 400);
    assert.equal(closed.body.message, "PERIOD_NOT_OPEN");
  });

  it("moves months only forward once a period is locked", async () => {
    const back = await as("payroll").post("/payroll-periods", { legalEntityId: homeId, year: YEAR, month: 3 });
    assert.equal(back.status, 409, "a month before the newest period was opened");
    assert.equal(back.body.message, "PERIOD_OUT_OF_ORDER");
    const same = await as("payroll").post("/payroll-periods", { legalEntityId: homeId, year: YEAR, month: 4 });
    assert.equal(same.status, 409);
    assert.equal(same.body.message, "PERIOD_TAKEN");
  });

  it("sends the other finished runs back to draft when the newest regular one is discarded", async () => {
    const june = await as("payroll").post("/payroll-periods", { legalEntityId: homeId, year: YEAR, month: 6 });
    assert.equal(june.status, 201, JSON.stringify(june.body));
    const first = await db.payrollRun.create({ data: { periodId: june.body.id, kind: "REGULAR" } });
    assert.equal((await payroll.runNow(first.id)).state, "DONE");
    const owed = await db.salaryAdvance.create({
      data: { employeeId: idOf.get(STAYER) as number, amount: ADVANCE, reason: "e2e", state: "PAID", paidAt: new Date() },
    });
    const second = await db.payrollRun.create({ data: { periodId: june.body.id, kind: "REGULAR" } });
    assert.equal((await payroll.runNow(second.id)).state, "DONE");

    assert.equal((await as("payroll").post(`/payroll-runs/${second.id}/discard`)).status, 201);
    const older = await db.payrollRun.findUniqueOrThrow({ where: { id: first.id } });
    assert.deepEqual([older.state, older.failure], ["DRAFT", "RUN_BASE_CHANGED"], "an older run stood in for the discarded one");
    const refused = await as("payroll").post(`/payroll-periods/${june.body.id}/lock`, { acceptOpenItems: true });
    assert.equal(refused.body.message, "RUN_BASE_CHANGED", JSON.stringify(refused.body));

    assert.equal((await payroll.runNow(first.id)).state, "DONE");
    const locked = await as("payroll").post(`/payroll-periods/${june.body.id}/lock`, { acceptOpenItems: true });
    assert.equal(locked.status, 201, JSON.stringify(locked.body));
    const slip = await db.payslip.findFirstOrThrow({
      where: { runId: first.id, employeeId: idOf.get(STAYER), state: { not: "DRAFT" } },
    });
    const kept = await db.salaryAdvance.findUniqueOrThrow({ where: { id: owed.id } });
    assert.deepEqual([kept.state, kept.payslipId], ["SETTLED", slip.id], "the advance was settled off a payslip that never went out");
  });

  it("pays one regular payslip a person a month, across entities, and names who is missing", async () => {
    const moverId = idOf.get(MOVER) as number;
    await db.employee.update({ where: { id: moverId }, data: { legalEntityId: awayId } });
    const april = await as("payroll").post("/payroll-periods", { legalEntityId: awayId, year: YEAR, month: 4 });
    assert.equal(april.status, 201, JSON.stringify(april.body));
    const run = await db.payrollRun.create({ data: { periodId: april.body.id, kind: "REGULAR" } });
    assert.equal((await payroll.runNow(run.id)).state, "DONE");
    assert.equal(await countOf(april.body.id, "PAID_ELSEWHERE"), 1, "the checklist missed a person already paid for the month");

    await hire(NEWCOMER, awayId);
    assert.equal(await countOf(april.body.id, "NOT_IN_RUN"), 1, "the checklist missed a person no run priced");

    const locked = await as("payroll").post(`/payroll-periods/${april.body.id}/lock`, { acceptOpenItems: true });
    assert.equal(locked.status, 201, JSON.stringify(locked.body));
    const paid = await db.payslip.count({
      where: {
        employeeId: moverId,
        state: { not: "DRAFT" },
        run: { kind: "REGULAR" },
        period: { year: YEAR, month: 4 },
      },
    });
    assert.equal(paid, 1, "one person got two regular payslips for one month");
  });

  it("hires nobody without an entity while there are several, and clears no entity", async () => {
    const stray = await as("admin").post("/employees", { code: STRAY, fullName: "Thử không pháp nhân" });
    assert.equal(stray.status, 400, JSON.stringify(stray.body));
    assert.equal(stray.body.message, "LEGAL_ENTITY_REQUIRED");
    const cleared = await as("admin").patch(`/employees/${idOf.get(STAYER)}`, { legalEntityId: null });
    assert.equal(cleared.status, 400, "an edit took a person's entity away");
  });
});
