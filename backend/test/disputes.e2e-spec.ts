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
import { PayrollService } from "../src/modules/payroll/payroll.service.js";

const ENTITY = "E2EDS";
const CODE = "E2EDS01";
const OTHER = "E2EDS02";
const EMAIL = "e2eds@kiosk.local";
const OTHER_EMAIL = "e2eds-other@kiosk.local";
const PASSWORD = "kiosk-e2e-password";
const YEAR = 2034;
const FIRST_MONTH = 3;
const NEXT_MONTH = 4;
const BASE = "20000000";
const OWED = 1_234_000;
const CLAIM = "Tăng ca tháng này thiếu 4 giờ";
const ANSWER = "Đã đối chiếu máy chấm công, trả bù 4 giờ";
const LINE = "OT";
const DAY_MS = 86_400_000;

interface Dispute {
  id: string;
  state: string;
  outcome: string | null;
  dueAt: string;
  createdAt: string;
  retroId: string | null;
}

describe("disputing a payslip (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let payroll: PayrollService;
  let desk = "";
  let mine = "";
  let theirs = "";
  let answerDays = 0;
  let employeeId = 0;
  let entityId = "";
  let firstPeriodId = "";
  let nextPeriodId = "";
  let issuedSlipId = "";
  let draftSlipId = "";
  let disputeId = "";

  async function sweep(): Promise<void> {
    await db.user.deleteMany({ where: { email: { in: [EMAIL, OTHER_EMAIL] } } });
    await db.employee.deleteMany({ where: { code: { in: [CODE, OTHER] } } });
    await db.payrollPeriod.deleteMany({ where: { year: YEAR } });
    await db.legalEntity.deleteMany({ where: { code: ENTITY } });
  }

  // Copied rather than typed out: the rates belong to the seed, and a second
  // set of them here would be a second thing to keep right (KEHOACH 4.9).
  async function copyPolicyTo(holder: string): Promise<void> {
    const { id, legalEntityId, createdAt, brackets, ...rates } =
      await db.payrollPolicy.findFirstOrThrow({
        orderBy: { effectiveFrom: "asc" },
        include: { brackets: { orderBy: { ordinal: "asc" } } },
      });
    await db.payrollPolicy.create({
      data: {
        ...rates,
        legalEntityId: holder,
        brackets: {
          create: brackets.map((one) => ({
            ordinal: one.ordinal,
            upToAmount: one.upToAmount,
            rateBp: one.rateBp,
          })),
        },
      },
    });
  }

  async function makePerson(code: string, email: string): Promise<number> {
    const made = await db.employee.create({
      data: {
        code,
        fullName: `Nguoi ${code}`,
        active: true,
        legalEntityId: entityId,
        hireDate: new Date(Date.UTC(YEAR - 1, 0, 1)),
        login: { create: { email, passwordHash: await hashPassword(PASSWORD), role: "EMPLOYEE" } },
      },
    });
    await db.compensationRecord.create({
      data: {
        employeeId: made.id,
        effectiveFrom: new Date(Date.UTC(YEAR - 1, 0, 1)),
        baseSalary: BASE,
        insuranceSalary: BASE,
      },
    });
    return made.id;
  }

  async function makePeriod(month: number): Promise<string> {
    const period = await db.payrollPeriod.create({
      data: {
        legalEntityId: entityId,
        year: YEAR,
        month,
        startDate: new Date(Date.UTC(YEAR, month - 1, 1)),
        endDate: new Date(Date.UTC(YEAR, month, 0)),
      },
    });
    return period.id;
  }

  async function signIn(email: string): Promise<string> {
    const res = await request(http).post("/auth/login").send({ email, password: PASSWORD });
    assert.equal(res.status, 200, `${email} could not sign in`);
    return res.body.accessToken as string;
  }

  before(async () => {
    const env = validateEnv();
    answerDays = env.DISPUTE_ANSWER_DAYS;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    http = app.getHttpServer();
    db = app.get(PrismaService);
    payroll = app.get(PayrollService);
    await sweep();

    const signedIn = await request(http)
      .post("/auth/login")
      .send({ email: "admin@kiosk.local", password: env.SEED_ADMIN_PASSWORD ?? "" });
    assert.equal(signedIn.status, 200, "admin could not sign in");
    desk = signedIn.body.accessToken;

    // Its own entity, because a run with no entity walks every active employee
    // in the database, including whatever another suite is holding.
    const entity = await db.legalEntity.create({ data: { code: ENTITY, name: "Thử khiếu nại" } });
    entityId = entity.id;
    await copyPolicyTo(entityId);
    employeeId = await makePerson(CODE, EMAIL);
    await makePerson(OTHER, OTHER_EMAIL);
    mine = await signIn(EMAIL);
    theirs = await signIn(OTHER_EMAIL);

    firstPeriodId = await makePeriod(FIRST_MONTH);
    const first = await db.payrollRun.create({
      data: { periodId: firstPeriodId, kind: "REGULAR", state: "DRAFT" },
    });
    await payroll.runNow(first.id);
    const slip = await db.payslip.findFirstOrThrow({
      where: { periodId: firstPeriodId, employeeId },
    });
    issuedSlipId = slip.id;
    draftSlipId = (
      await db.payslip.findFirstOrThrow({
        where: { periodId: firstPeriodId, employeeId: { not: employeeId } },
      })
    ).id;
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("refuses a dispute on a payslip nobody has issued", async () => {
    const res = await request(http)
      .post("/payslip-disputes")
      .set("Authorization", `Bearer ${mine}`)
      .send({ payslipId: issuedSlipId, claim: CLAIM });
    assert.equal(res.status, 400);
    assert.equal(res.body.message, "PAYSLIP_NOT_ISSUED");
  });

  it("issues the payslips when the period locks", async () => {
    const res = await request(http)
      .post(`/payroll-periods/${firstPeriodId}/lock`)
      .set("Authorization", `Bearer ${desk}`)
      .send({ acceptOpenItems: true });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const slip = await db.payslip.findUniqueOrThrow({ where: { id: issuedSlipId } });
    assert.equal(slip.state, "ISSUED");
  });

  it("takes the dispute with a deadline counted from the day it arrived", async () => {
    const res = await request(http)
      .post("/payslip-disputes")
      .set("Authorization", `Bearer ${mine}`)
      .send({ payslipId: issuedSlipId, lineCode: LINE, claim: CLAIM });
    assert.equal(res.status, 201);
    const made = res.body as Dispute;
    assert.equal(made.state, "OPEN");
    const span = new Date(made.dueAt).getTime() - new Date(made.createdAt).getTime();
    assert.equal(Math.round(span / DAY_MS), answerDays, "the deadline is not the configured span");
    disputeId = made.id;
  });

  it("keeps one open dispute per line", async () => {
    const res = await request(http)
      .post("/payslip-disputes")
      .set("Authorization", `Bearer ${mine}`)
      .send({ payslipId: issuedSlipId, lineCode: LINE, claim: CLAIM });
    assert.equal(res.status, 409);
    assert.equal(res.body.message, "DISPUTE_ALREADY_OPEN");
  });

  it("keeps somebody out of a payslip that is not theirs", async () => {
    const res = await request(http)
      .post("/payslip-disputes")
      .set("Authorization", `Bearer ${theirs}`)
      .send({ payslipId: issuedSlipId, claim: CLAIM });
    assert.equal(res.status, 404);
  });

  it("keeps the person who raised it from answering it", async () => {
    const res = await request(http)
      .post(`/payslip-disputes/${disputeId}/answer`)
      .set("Authorization", `Bearer ${mine}`)
      .send({ outcome: "REJECTED", answer: ANSWER });
    assert.equal(res.status, 403);
    assert.equal(res.body.message, "PAYROLL_WRITE_DENIED");
  });

  it("shows an overdue dispute in the checklist of the next period", async () => {
    nextPeriodId = await makePeriod(NEXT_MONTH);
    const clear = await request(http)
      .get(`/payroll-periods/${nextPeriodId}/checklist`)
      .set("Authorization", `Bearer ${desk}`);
    assert.equal(clear.status, 200);
    const before = (clear.body as { code: string; count: number }[]).find(
      (one) => one.code === "DISPUTES_OVERDUE",
    );
    assert.equal(before?.count, 0, "a dispute inside its deadline is already counted late");

    await db.payslipDispute.update({
      where: { id: disputeId },
      data: { dueAt: new Date(Date.now() - DAY_MS) },
    });
    const late = await request(http)
      .get(`/payroll-periods/${nextPeriodId}/checklist`)
      .set("Authorization", `Bearer ${desk}`);
    assert.equal(late.status, 200);
    const counted = (late.body as { code: string; count: number }[]).find(
      (one) => one.code === "DISPUTES_OVERDUE",
    );
    assert.equal(counted?.count, 1, "the deadline passed and nothing noticed");
  });

  it("lists it as overdue without touching the ones inside their deadline", async () => {
    const res = await request(http)
      .get("/payslip-disputes?overdue=true")
      .set("Authorization", `Bearer ${desk}`);
    assert.equal(res.status, 200);
    const rows = (res.body as { rows: Dispute[] }).rows;
    assert.ok(
      rows.some((one) => one.id === disputeId),
      "the overdue filter does not return the overdue one",
    );
    assert.ok(rows.every((one) => one.state === "OPEN"));
  });

  it("mints the adjustment that carries the money when it upholds one", async () => {
    const slipBefore = await db.payslip.findUniqueOrThrow({ where: { id: issuedSlipId } });
    const res = await request(http)
      .post(`/payslip-disputes/${disputeId}/answer`)
      .set("Authorization", `Bearer ${desk}`)
      .send({ outcome: "UPHELD", answer: ANSWER, amount: OWED, code: "OT" });
    assert.equal(res.status, 201);
    const answered = res.body as Dispute;
    assert.equal(answered.outcome, "UPHELD");
    assert.ok(answered.retroId, "upholding it attached no money to it");

    const retro = await db.retroAdjustment.findUniqueOrThrow({ where: { id: answered.retroId! } });
    assert.equal(retro.state, "PENDING");
    assert.equal(retro.employeeId, employeeId);
    assert.equal(retro.sourcePeriodId, firstPeriodId);
    assert.equal(retro.amount.toFixed(0), String(OWED));

    const slipAfter = await db.payslip.findUniqueOrThrow({ where: { id: issuedSlipId } });
    assert.equal(
      slipAfter.netPay.toFixed(0),
      slipBefore.netPay.toFixed(0),
      "a payslip already sent out moved behind its reader",
    );
  });

  it("refuses to answer the same dispute twice", async () => {
    const res = await request(http)
      .post(`/payslip-disputes/${disputeId}/answer`)
      .set("Authorization", `Bearer ${desk}`)
      .send({ outcome: "REJECTED", answer: ANSWER });
    assert.equal(res.status, 400);
    assert.equal(res.body.message, "DISPUTE_ALREADY_ANSWERED");
  });

  // The whole point of the record: the answer is a figure somebody receives,
  // not a sentence somebody wrote (KEHOACH 9.17 item 11).
  it("pays it on the next payslip and settles it when that period locks", async () => {
    const next = await db.payrollRun.create({
      data: { periodId: nextPeriodId, kind: "REGULAR", state: "DRAFT" },
    });
    await payroll.runNow(next.id);
    const slip = await db.payslip.findFirstOrThrow({
      where: { periodId: nextPeriodId, employeeId },
      include: { lines: true },
    });
    const carried = slip.lines.find((one) => one.code === "RETRO_OT");
    assert.ok(carried, "the next payslip carries no line for what was owed");
    assert.equal(carried.amount.toFixed(0), String(OWED));

    const locked = await request(http)
      .post(`/payroll-periods/${nextPeriodId}/lock`)
      .set("Authorization", `Bearer ${desk}`)
      .send({ acceptOpenItems: true });
    assert.equal(locked.status, 201, JSON.stringify(locked.body));
    const retro = await db.retroAdjustment.findFirstOrThrow({ where: { employeeId } });
    assert.equal(retro.state, "APPLIED");
    assert.equal(retro.appliedPeriodId, nextPeriodId);
  });

  it("lets somebody take back a dispute nobody has answered", async () => {
    const asked = await request(http)
      .post("/payslip-disputes")
      .set("Authorization", `Bearer ${mine}`)
      .send({ payslipId: issuedSlipId, claim: CLAIM });
    assert.equal(asked.status, 201);
    const id = (asked.body as Dispute).id;

    const notTheirs = await request(http)
      .post(`/payslip-disputes/${id}/withdraw`)
      .set("Authorization", `Bearer ${theirs}`);
    assert.equal(notTheirs.status, 403);
    assert.equal(notTheirs.body.message, "DISPUTE_NOT_YOURS");

    const taken = await request(http)
      .post(`/payslip-disputes/${id}/withdraw`)
      .set("Authorization", `Bearer ${mine}`);
    assert.equal(taken.status, 201);
    assert.equal((taken.body as Dispute).state, "WITHDRAWN");
  });

  it("tells the person their dispute has an answer", async () => {
    const notice = await db.notification.findFirst({
      where: { employeeId, kind: "DISPUTE_ANSWERED" },
    });
    assert.ok(notice, "nobody told the person the answer had arrived");
    assert.equal(notice.payslipId, issuedSlipId);
  });

  it("files the dispute and its answer under the payslip", async () => {
    const res = await request(http)
      .get(`/audit?subjectType=payroll&subjectId=${issuedSlipId}`)
      .set("Authorization", `Bearer ${desk}`);
    assert.equal(res.status, 200);
    const kinds = new Set((res.body.rows as { action: string }[]).map((one) => one.action));
    assert.ok(kinds.has("dispute.raise"));
    assert.ok(kinds.has("dispute.answer"));
  });
});
