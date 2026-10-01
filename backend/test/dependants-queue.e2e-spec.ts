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

const HOLDER = "E2EDQ01";
const HOLDER_MAIL = "e2edq-holder@kiosk.local";
const PASSWORD = "kiosk-e2e-password";
const WAITING = 3;

interface Queue {
  rows: { id: string }[];
  total: number;
  totalIsExact: boolean;
}

describe("the dependants queue says how much is waiting (e2e)", () => {
  let app: INestApplication;
  let db: PrismaService;
  let token = "";
  let holderToken = "";
  let holderId = 0;
  let filedId = "";

  async function sweep(): Promise<void> {
    await clearDeskNotices(db, [HOLDER]);
    await db.user.deleteMany({ where: { email: HOLDER_MAIL } });
    await db.employee.deleteMany({ where: { code: HOLDER } });
  }

  before(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    db = app.get(PrismaService);
    await sweep();

    const made = await db.employee.create({
      data: { code: HOLDER, fullName: "Giữ người phụ thuộc", active: true },
    });
    holderId = made.id;
    await db.dependent.createMany({
      data: Array.from({ length: WAITING }, (unused, at) => ({
        employeeId: holderId,
        fullName: `Người phụ thuộc ${at}`,
        relation: "CHILD" as const,
        fromMonth: new Date(Date.UTC(2039, at, 1)),
        state: "PENDING" as const,
      })),
    });
    await db.user.create({
      data: { email: HOLDER_MAIL, passwordHash: await hashPassword(PASSWORD), role: "EMPLOYEE", employeeId: holderId },
    });
    const auth = app.get(AuthService);
    token = (await auth.signIn("admin@kiosk.local", validateEnv().SEED_ADMIN_PASSWORD ?? "", {})).accessToken;
    holderToken = (await auth.signIn(HOLDER_MAIL, PASSWORD, {})).accessToken;
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("answers with rows beside a count, not a bare list", async () => {
    const res = await request(app.getHttpServer())
      .get("/dependents?state=PENDING")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.equal(Array.isArray(res.body), false, "a bare list carries no count to read");
    const page = res.body as Queue;
    assert.equal(typeof page.total, "number");
    assert.equal(page.totalIsExact, true);
  });

  it("counts every registration waiting, not only the ones on this page", async () => {
    const res = await request(app.getHttpServer())
      .get("/dependents?state=PENDING")
      .set("Authorization", `Bearer ${token}`);
    const page = res.body as Queue;
    const mine = await db.dependent.count({ where: { employeeId: holderId, state: "PENDING" } });
    assert.equal(mine, WAITING, "the fixture lost the rows this suite counts");
    assert.ok(
      page.total >= WAITING,
      `the queue reported ${page.total} with ${WAITING} of this suite's own waiting`,
    );
    assert.ok(page.total >= page.rows.length, "a count smaller than its own page is not a count");
  });

  it("tells the pay desk a registration is waiting, and never the person it would pay less tax", async () => {
    const res = await request(app.getHttpServer())
      .post("/dependents")
      .set("Authorization", `Bearer ${holderToken}`)
      .send({ fullName: "Con thứ tư", relation: "CHILD", fromMonth: "2039-06-01" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    filedId = res.body.id as string;
    // One statement: a desk login another suite deletes mid-read is wholly in or out.
    const told = await db.user.findMany({
      where: { notifications: { some: { kind: "REQUEST_WAITING", subjectId: filedId } } },
      select: { role: true, employeeId: true },
    });
    assert.ok(told.length > 0, "nobody was told a dependant waits to be decided");
    assert.ok(
      told.every((one) => one.role === "ADMIN" || one.role === "PAYROLL"),
      "somebody who cannot decide a dependant was told to",
    );
    assert.ok(!told.some((one) => one.employeeId === holderId), "the claimant was asked to decide their own");
  });

  it("tells the person how their registration was answered, once", async () => {
    const res = await request(app.getHttpServer())
      .post(`/dependents/${filedId}/decide`)
      .set("Authorization", `Bearer ${token}`)
      .send({ approve: true });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const told = await db.notification.findMany({
      where: { kind: "REQUEST_DECIDED", subjectId: filedId },
      select: { approved: true, user: { select: { employeeId: true } } },
    });
    assert.equal(told.length, 1, "the answer reached nobody, or somebody twice");
    assert.equal(told[0]?.user.employeeId, holderId);
    assert.equal(told[0]?.approved, true);
  });
});
