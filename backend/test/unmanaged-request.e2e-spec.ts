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

const LONE = "E2EUR01";
const LONE_MAIL = "e2eur-lone@kiosk.local";
const PASSWORD = "kiosk-e2e-password";
const DAY = "2039-05-02";

describe("a request filed by somebody with no manager (e2e)", () => {
  let app: INestApplication;
  let db: PrismaService;
  let desk = "";
  let mine = "";
  let loneId = 0;

  async function sweep(): Promise<void> {
    await db.user.deleteMany({ where: { email: LONE_MAIL } });
    await db.employee.deleteMany({ where: { code: LONE } });
  }

  before(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    db = app.get(PrismaService);
    await sweep();

    const made = await db.employee.create({
      data: { code: LONE, fullName: "Không có quản lý", active: true, managerId: null },
    });
    loneId = made.id;
    await db.user.create({
      data: {
        email: LONE_MAIL,
        passwordHash: await hashPassword(PASSWORD),
        role: "EMPLOYEE",
        employeeId: loneId,
      },
    });
    const auth = app.get(AuthService);
    mine = (await auth.signIn(LONE_MAIL, PASSWORD, {})).accessToken;
    desk = (
      await auth.signIn("admin@kiosk.local", validateEnv().SEED_ADMIN_PASSWORD ?? "", {})
    ).accessToken;
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("is taken, so the reader believes somebody will answer it", async () => {
    const res = await request(app.getHttpServer())
      .post("/requests")
      .set("Authorization", `Bearer ${mine}`)
      .send({ kind: "REMOTE_WORK", fromDate: DAY, toDate: DAY, reason: "e2e" });
    assert.equal(res.status, 201);
    assert.equal(res.body.state, "PENDING");
  });

  it("reaches a desk that can answer it", async () => {
    const res = await request(app.getHttpServer())
      .get("/requests/inbox")
      .set("Authorization", `Bearer ${desk}`);
    assert.equal(res.status, 200);
    const rows = (res.body as { rows: { employeeId: number }[] }).rows;
    assert.ok(
      rows.some((row) => row.employeeId === loneId),
      "the request is waiting in nobody's inbox",
    );
  });

  it("reaches a desk login that is not an employee, which is the whole point", async () => {
    const mineOnly = await db.request.findFirstOrThrow({ where: { employeeId: loneId } });
    const told = await db.notification.findMany({
      where: { kind: "REQUEST_WAITING", requestId: mineOnly.id },
      select: { user: { select: { email: true, employeeId: true } } },
    });
    assert.ok(
      told.some((one) => one.user.employeeId === null),
      "a login with no employee row was still unreachable",
    );
  });

  it("tells somebody it is waiting", async () => {
    const mineOnly = await db.request.findFirstOrThrow({ where: { employeeId: loneId } });
    const told = await db.notification.count({
      where: { kind: "REQUEST_WAITING", requestId: mineOnly.id },
    });
    assert.ok(told > 0, "nobody was told this request is waiting");
  });
});
