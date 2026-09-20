import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";

const MADE_EMAIL = "e2e-hr@kiosk.local";
const MADE_PASSWORD = "a-long-enough-password";

describe("users and audit (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let admin = "";
  let viewer = "";
  let madeId = "";

  before(async () => {
    const env = validateEnv();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    http = app.getHttpServer();
    db = app.get(PrismaService);
    await db.user.deleteMany({ where: { email: MADE_EMAIL } });

    const sign = async (email: string) => {
      const res = await request(http)
        .post("/auth/login")
        .send({ email, password: env.SEED_ADMIN_PASSWORD });
      return res.body.accessToken as string;
    };
    admin = await sign("admin@kiosk.local");
    viewer = await sign("viewer@kiosk.local");
  });

  after(async () => {
    await db.user.deleteMany({ where: { email: MADE_EMAIL } });
    await app.close();
  });

  it("keeps the account list away from anyone but an administrator", async () => {
    const res = await request(http).get("/users").set("Authorization", `Bearer ${viewer}`);
    assert.equal(res.status, 403);
  });

  it("creates an account and never shows its hash", async () => {
    const res = await request(http)
      .post("/users")
      .set("Authorization", `Bearer ${admin}`)
      .send({ email: MADE_EMAIL, password: MADE_PASSWORD, role: "HR" });
    assert.equal(res.status, 201);
    assert.equal(res.body.role, "HR");
    assert.deepEqual(
      Object.keys(res.body).sort(),
      ["createdAt", "email", "id", "role", "updatedAt"],
      "the account answer carries a field nobody chose to publish",
    );
    madeId = res.body.id;
  });

  it("lets the new account sign in with the password it was given", async () => {
    const res = await request(http)
      .post("/auth/login")
      .send({ email: MADE_EMAIL, password: MADE_PASSWORD });
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.accessToken, "string");
  });

  it("refuses a password too short to be worth hashing", async () => {
    const res = await request(http)
      .post("/users")
      .set("Authorization", `Bearer ${admin}`)
      .send({ email: "short@kiosk.local", password: "short", role: "VIEWER" });
    assert.equal(res.status, 400);
  });

  it("refuses to delete the last administrator", async () => {
    const admins = await db.user.findMany({ where: { role: "ADMIN" } });
    assert.equal(admins.length, 1, "the seed is expected to leave one administrator");
    const res = await request(http)
      .delete(`/users/${admins[0].id}`)
      .set("Authorization", `Bearer ${admin}`);
    assert.equal(res.status, 400);
  });

  it("wrote down the changes an administrator made", async () => {
    const res = await request(http).get("/audit").set("Authorization", `Bearer ${admin}`);
    assert.equal(res.status, 200);
    const made = (res.body.rows as { action: string; subjectType: string; subjectId: string }[])
      .find((row) => row.action === "user.create" && row.subjectId === madeId);
    assert.ok(made, "creating an account left no trace in the audit log");
    assert.equal(made.subjectType, "user");
  });

  it("opens no more logins in one call than it is allowed to", async () => {
    const batch = validateEnv().PROVISION_BATCH;
    const codes = Array.from({ length: batch + 3 }, (unused, at) => `E2EPV${String(at).padStart(4, "0")}`);
    await db.employee.deleteMany({ where: { code: { in: codes } } });
    await db.user.deleteMany({ where: { email: { startsWith: "e2epv-" } } });
    await db.employee.createMany({
      data: codes.map((code, at) => ({
        code,
        fullName: `Chờ mở ${at}`,
        active: true,
        personalEmail: `e2epv-${at}@kiosk.local`,
      })),
    });

    const res = await request(http)
      .post("/users/provision")
      .set("Authorization", `Bearer ${admin}`);
    assert.equal(res.status, 201);
    const done = res.body as { accounts: { email: string }[]; waiting: number };
    assert.equal(done.accounts.length, batch, "one call opened more logins than the batch allows");
    assert.ok(done.waiting >= 3, "the answer does not say how many people are still waiting");

    await db.user.deleteMany({ where: { email: { startsWith: "e2epv-" } } });
    await db.employee.deleteMany({ where: { code: { in: codes } } });
  });

  it("answers every error in one shape", async () => {
    const res = await request(http).get("/audit").set("Authorization", `Bearer ${viewer}`);
    assert.equal(res.status, 403);
    assert.equal(res.body.statusCode, 403);
    assert.equal(typeof res.body.path, "string");
    assert.equal(typeof res.body.ts, "string");
  });

  it("deletes the account it made", async () => {
    const res = await request(http)
      .delete(`/users/${madeId}`)
      .set("Authorization", `Bearer ${admin}`);
    assert.equal(res.status, 204);
  });
});
