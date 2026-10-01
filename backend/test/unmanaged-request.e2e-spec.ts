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

const LONE = "E2EUR01";
const UNSIGNED_BOSS = "E2EUR02";
const UNSIGNED_REPORT = "E2EUR03";
const LOCKED_BOSS = "E2EUR04";
const LOCKED_REPORT = "E2EUR05";
const CODES = [LONE, UNSIGNED_REPORT, LOCKED_REPORT, UNSIGNED_BOSS, LOCKED_BOSS];
const MAIL = (code: string) => `${code.toLowerCase()}@kiosk.local`;
const PASSWORD = "kiosk-e2e-password";
const DAY = "2039-05-02";

describe("a request nobody above can answer reaches the desk (e2e)", () => {
  let app: INestApplication;
  let db: PrismaService;
  let desk = "";
  const token = new Map<string, string>();
  const id = new Map<string, number>();
  const filed = new Map<string, string>();

  async function sweep(): Promise<void> {
    await clearDeskNotices(db, CODES);
    await db.user.deleteMany({ where: { email: { in: CODES.map(MAIL) } } });
    await db.employee.deleteMany({ where: { code: { in: [LONE, UNSIGNED_REPORT, LOCKED_REPORT] } } });
    await db.employee.deleteMany({ where: { code: { in: [UNSIGNED_BOSS, LOCKED_BOSS] } } });
  }

  async function person(code: string, managerId: number | null, login: "open" | "locked" | "none"): Promise<number> {
    const made = await db.employee.create({ data: { code, fullName: `Người ${code}`, active: true, managerId } });
    id.set(code, made.id);
    if (login !== "none") {
      await db.user.create({
        data: {
          email: MAIL(code),
          passwordHash: await hashPassword(PASSWORD),
          role: managerId === null && code !== LONE ? "MANAGER" : "EMPLOYEE",
          employeeId: made.id,
          active: login === "open",
        },
      });
    }
    return made.id;
  }

  async function inboxOf(code: string): Promise<{ id: string }[]> {
    const res = await request(app.getHttpServer())
      .get(`/requests/inbox?search=${code}`)
      .set("Authorization", `Bearer ${desk}`);
    assert.equal(res.status, 200);
    return (res.body as { rows: { id: string }[] }).rows;
  }

  async function toldAbout(requestId: string): Promise<{ role: string; employeeId: number | null }[]> {
    // One statement: a desk login another suite deletes mid-read is wholly in or out.
    return db.user.findMany({
      where: { notifications: { some: { kind: "REQUEST_WAITING", subjectId: requestId } } },
      select: { role: true, employeeId: true },
    });
  }

  before(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    db = app.get(PrismaService);
    await sweep();

    await person(LONE, null, "open");
    await person(UNSIGNED_REPORT, await person(UNSIGNED_BOSS, null, "none"), "open");
    await person(LOCKED_REPORT, await person(LOCKED_BOSS, null, "locked"), "open");
    const auth = app.get(AuthService);
    for (const code of [LONE, UNSIGNED_REPORT, LOCKED_REPORT]) {
      token.set(code, (await auth.signIn(MAIL(code), PASSWORD, {})).accessToken);
    }
    desk = (await auth.signIn("admin@kiosk.local", validateEnv().SEED_ADMIN_PASSWORD ?? "", {})).accessToken;
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("is taken, so the reader believes somebody will answer it", async () => {
    for (const code of [LONE, UNSIGNED_REPORT, LOCKED_REPORT]) {
      const res = await request(app.getHttpServer())
        .post("/requests")
        .set("Authorization", `Bearer ${token.get(code) ?? ""}`)
        .send({ kind: "REMOTE_WORK", fromDate: DAY, toDate: DAY, reason: "e2e" });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      assert.equal(res.body.state, "PENDING");
      filed.set(code, res.body.id as string);
    }
  });

  it("reaches a desk that can answer it", async () => {
    assert.ok(
      (await inboxOf(LONE)).some((row) => row.id === filed.get(LONE)),
      "the request is waiting in nobody's inbox",
    );
  });

  it("reaches a desk login that is not an employee, which is the whole point", async () => {
    const told = await toldAbout(filed.get(LONE) ?? "");
    assert.ok(
      told.some((one) => one.employeeId === null),
      "a login with no employee row was still unreachable",
    );
  });

  it("tells somebody it is waiting", async () => {
    const told = await db.notification.count({
      where: { kind: "REQUEST_WAITING", subjectId: filed.get(LONE) },
    });
    assert.ok(told > 0, "nobody was told this request is waiting");
  });

  it("goes to the desk when the manager has no login to answer it with", async () => {
    const mine = filed.get(UNSIGNED_REPORT) ?? "";
    const held = await db.request.findUniqueOrThrow({ where: { id: mine } });
    assert.equal(held.approverId, id.get(UNSIGNED_BOSS), "the request lost its place in the tree");
    assert.ok((await inboxOf(UNSIGNED_REPORT)).some((row) => row.id === mine), "the desk cannot see it");
    const told = await toldAbout(mine);
    assert.ok(told.length > 0, "nobody was told a request with an unreachable manager is waiting");
    assert.ok(told.every((one) => one.role === "ADMIN" || one.role === "HR"), "somebody off the desk was told");
  });

  it("goes to the desk when the manager's login is locked", async () => {
    const mine = filed.get(LOCKED_REPORT) ?? "";
    assert.ok((await inboxOf(LOCKED_REPORT)).some((row) => row.id === mine), "the desk cannot see it");
    const told = await toldAbout(mine);
    assert.ok(told.length > 0, "nobody was told a request with a locked manager is waiting");
    assert.ok(!told.some((one) => one.employeeId === id.get(LOCKED_BOSS)), "a locked login was told");
  });

  it("lets the desk answer it, and says who did", async () => {
    const mine = filed.get(LOCKED_REPORT) ?? "";
    const res = await request(app.getHttpServer())
      .post(`/requests/${mine}/decide`)
      .set("Authorization", `Bearer ${desk}`)
      .send({ approve: true });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const admin = await db.user.findUniqueOrThrow({ where: { email: "admin@kiosk.local" } });
    assert.equal(res.body.decidedById, admin.id, "the request does not say who answered it");
    assert.ok(!(await inboxOf(LOCKED_REPORT)).some((row) => row.id === mine), "a decided request still waits");
  });
});
