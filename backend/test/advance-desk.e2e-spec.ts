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

const BOSS = "E2EAD01";
const BOSS_MAIL = "e2ead-boss@kiosk.local";
const ASKER = "E2EAD02";
const ASKER_MAIL = "e2ead-asker@kiosk.local";
const PASSWORD = "kiosk-e2e-password";
const AMOUNT = 1_234_000;

describe("an advance lands on the desk, not on the tree (e2e)", () => {
  let app: INestApplication;
  let db: PrismaService;
  let deskToken = "";
  let bossToken = "";
  let askerToken = "";
  let payrollToken = "";
  let askerId = 0;
  let bossId = 0;
  let filedId = "";

  async function sweep(): Promise<void> {
    await clearDeskNotices(db, [BOSS, ASKER]);
    await db.user.deleteMany({ where: { email: { in: [BOSS_MAIL, ASKER_MAIL] } } });
    await db.salaryAdvance.deleteMany({ where: { employee: { code: { in: [BOSS, ASKER] } } } });
    await db.employee.deleteMany({ where: { code: { in: [ASKER, BOSS] } } });
  }

  async function login(email: string, password: string): Promise<string> {
    return (await app.get(AuthService).signIn(email, password, {})).accessToken;
  }

  before(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    db = app.get(PrismaService);
    await sweep();

    const hash = await hashPassword(PASSWORD);
    bossId = (
      await db.employee.create({ data: { code: BOSS, fullName: "Quản lý E2E", active: true } })
    ).id;
    askerId = (
      await db.employee.create({
        data: { code: ASKER, fullName: "Người xin E2E", active: true, managerId: bossId },
      })
    ).id;
    await db.user.create({
      data: { email: BOSS_MAIL, passwordHash: hash, role: "MANAGER", employeeId: bossId },
    });
    await db.user.create({
      data: { email: ASKER_MAIL, passwordHash: hash, role: "EMPLOYEE", employeeId: askerId },
    });

    const seeded = validateEnv().SEED_ADMIN_PASSWORD ?? "";
    bossToken = await login(BOSS_MAIL, PASSWORD);
    askerToken = await login(ASKER_MAIL, PASSWORD);
    deskToken = await login("admin@kiosk.local", seeded);
    payrollToken = await login("payroll@kiosk.local", seeded);
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("is filed without naming anyone to decide it", async () => {
    const res = await request(app.getHttpServer())
      .post("/advances")
      .set("Authorization", `Bearer ${askerToken}`)
      .send({ amount: AMOUNT, reason: "e2e" });
    assert.equal(res.status, 201);
    assert.equal(res.body.state, "PENDING");
    filedId = res.body.id as string;
    assert.ok(!("approverId" in res.body), "the advance still carries an approver");
  });

  it("tells the desk, and tells it about this advance", async () => {
    const told = await db.notification.findMany({
      where: { kind: "REQUEST_WAITING", advanceId: filedId },
      select: { user: { select: { role: true, employeeId: true } } },
    });
    assert.ok(told.length > 0, "nobody was told an advance is waiting");
    assert.ok(
      told.every((one) => one.user.role === "ADMIN" || one.user.role === "HR"),
      "somebody off the desk was told to decide an advance",
    );
    assert.ok(
      !told.some((one) => one.user.employeeId === bossId),
      "the line manager was told to decide money they cannot see",
    );
  });

  it("stays out of the manager's list", async () => {
    const res = await request(app.getHttpServer())
      .get("/advances")
      .set("Authorization", `Bearer ${bossToken}`);
    assert.equal(res.status, 200);
    const rows = (res.body as { rows: { id: string }[] }).rows;
    assert.ok(
      !rows.some((row) => row.id === filedId),
      "a manager reads what a subordinate borrowed",
    );
  });

  it("is refused to the manager, who cannot read the pay it is drawn against", async () => {
    const res = await request(app.getHttpServer())
      .post(`/advances/${filedId}/decide`)
      .set("Authorization", `Bearer ${bossToken}`)
      .send({ approve: true });
    assert.equal(res.status, 403);
    assert.equal(res.body.message, "ADVANCE_DECIDE_DENIED");
  });

  it("is refused to the desk that pays it, so one sum needs two desks", async () => {
    const res = await request(app.getHttpServer())
      .post(`/advances/${filedId}/decide`)
      .set("Authorization", `Bearer ${payrollToken}`)
      .send({ approve: true });
    assert.equal(res.status, 403);
    assert.equal(res.body.message, "ADVANCE_DECIDE_DENIED");
  });

  it("is still the asker's own to read and to withdraw", async () => {
    const res = await request(app.getHttpServer())
      .get("/advances")
      .set("Authorization", `Bearer ${askerToken}`);
    assert.equal(res.status, 200);
    const rows = (res.body as { rows: { id: string }[] }).rows;
    assert.ok(rows.some((row) => row.id === filedId), "the asker lost sight of their own advance");
  });

  it("is decided by the desk, and the asker hears the outcome", async () => {
    const res = await request(app.getHttpServer())
      .post(`/advances/${filedId}/decide`)
      .set("Authorization", `Bearer ${deskToken}`)
      .send({ approve: true });
    assert.equal(res.status, 201);
    assert.equal(res.body.state, "APPROVED");

    const told = await db.notification.findMany({
      where: { kind: "REQUEST_DECIDED", advanceId: filedId },
      select: { approved: true, user: { select: { employeeId: true } } },
    });
    assert.equal(told.length, 1);
    assert.equal(told[0]?.user.employeeId, askerId);
    assert.equal(told[0]?.approved, true);
  });
});
