import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { AuthService } from "../src/modules/auth/auth.service.js";
import { hashPassword } from "../src/modules/auth/password.js";
import { clearDeskNotices } from "./teardown.js";

const BOSS = "E2ESR01";
const WORKER = "E2ESR02";
const CODES = [BOSS, WORKER];
const MAIL = (code: string) => `${code.toLowerCase()}@kiosk.local`;
const PASSWORD = "kiosk-e2e-password";
const PAY_YEAR = 1995;
const NET = 17_171_717;

interface Hit {
  kind: string;
  id: string;
  detail: string;
  href: string;
  requestKind?: string;
}

describe("the global search box (e2e)", () => {
  let app: INestApplication;
  let db: PrismaService;
  let boss = "";
  let worker = "";
  let payroll = "";
  let requestId = "";
  let periodId = "";

  async function sweep(): Promise<void> {
    await clearDeskNotices(db, CODES);
    await db.payrollPeriod.deleteMany({ where: { year: PAY_YEAR } });
    await db.user.deleteMany({ where: { email: { in: CODES.map(MAIL) } } });
    await db.employee.deleteMany({ where: { code: { in: [WORKER] } } });
    await db.employee.deleteMany({ where: { code: { in: [BOSS] } } });
  }

  async function find(token: string, q: string): Promise<Hit[]> {
    const res = await request(app.getHttpServer())
      .get(`/search?q=${encodeURIComponent(q)}`)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body as Hit[];
  }

  before(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    db = app.get(PrismaService);
    await sweep();

    const hash = await hashPassword(PASSWORD);
    const bossRow = await db.employee.create({
      data: { code: BOSS, fullName: "Trưởng nhóm tìm kiếm", active: true, login: { create: { email: MAIL(BOSS), passwordHash: hash, role: "MANAGER" } } },
    });
    const workerRow = await db.employee.create({
      data: {
        code: WORKER,
        fullName: "Công nhân tìm kiếm",
        active: true,
        managerId: bossRow.id,
        login: { create: { email: MAIL(WORKER), passwordHash: hash, role: "EMPLOYEE" } },
      },
    });
    requestId = (
      await db.request.create({
        data: {
          employeeId: workerRow.id,
          kind: "REMOTE_WORK",
          state: "PENDING",
          fromDate: new Date("2040-02-03"),
          toDate: new Date("2040-02-03"),
          reason: "Làm ở nhà",
          approverId: bossRow.id,
        },
      })
    ).id;
    const policy = await db.payrollPolicy.findFirstOrThrow();
    periodId = (
      await db.payrollPeriod.create({
        data: { year: PAY_YEAR, month: 5, startDate: new Date(Date.UTC(PAY_YEAR, 4, 1)), endDate: new Date(Date.UTC(PAY_YEAR, 5, 0)) },
      })
    ).id;
    const run = await db.payrollRun.create({ data: { periodId, kind: "REGULAR", state: "DONE" } });
    await db.payslip.create({
      data: { runId: run.id, periodId, employeeId: workerRow.id, policyId: policy.id, state: "ISSUED", grossPay: NET, netPay: NET },
    });

    const auth = app.get(AuthService);
    boss = (await auth.signIn(MAIL(BOSS), PASSWORD, {})).accessToken;
    worker = (await auth.signIn(MAIL(WORKER), PASSWORD, {})).accessToken;
    payroll = (await auth.signIn("payroll@kiosk.local", validateEnv().SEED_ADMIN_PASSWORD ?? "", {})).accessToken;
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("finds a request by the name of the person who filed it", async () => {
    const hits = await find(boss, "Công nhân tìm");
    const hit = hits.find((one) => one.kind === "request" && one.id === requestId);
    assert.ok(hit, "a request could only be found by its reason");
    assert.equal(hit.requestKind, "REMOTE_WORK");
    assert.equal(hit.href, `/leave/${requestId}`);
  });

  it("never shows a manager a subordinate's payslip", async () => {
    const hits = await find(boss, WORKER);
    assert.ok(hits.some((one) => one.kind === "employee"), "the manager cannot find their own report");
    assert.ok(!hits.some((one) => one.kind === "payslip"), "a manager found a subordinate's payslip");
  });

  it("gives the pay desk the payslip, without its amount", async () => {
    const hits = await find(payroll, WORKER);
    const hit = hits.find((one) => one.kind === "payslip");
    assert.ok(hit, "the pay desk cannot find the payslip");
    assert.equal(hit.href, `/payroll/${periodId}`);
    assert.ok(!hit.detail.includes(String(NET)), "the search box showed an amount");
  });

  it("sends a person to their own pages", async () => {
    const hits = await find(worker, WORKER);
    assert.equal(hits.find((one) => one.kind === "payslip")?.href, "/me/payslips");
    assert.equal(hits.find((one) => one.kind === "request")?.href, `/me/requests?open=${requestId}`);
  });

  it("refuses a term longer than the box takes", async () => {
    const res = await request(app.getHttpServer())
      .get(`/search?q=${"a".repeat(65)}`)
      .set("Authorization", `Bearer ${boss}`);
    assert.equal(res.status, 400);
  });
});
