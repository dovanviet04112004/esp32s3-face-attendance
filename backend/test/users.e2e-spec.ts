import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
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

  async function sweep(): Promise<void> {
    const held = await db.user.findMany({ where: { email: MADE_EMAIL }, select: { id: true } });
    await db.passwordSetup.deleteMany({ where: { userId: { in: held.map((one) => one.id) } } });
    await db.user.deleteMany({ where: { email: MADE_EMAIL } });
  }

  after(async () => {
    await sweep();
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
      .send({ email: MADE_EMAIL, role: "HR" });
    assert.equal(res.status, 201);
    assert.equal(res.body.role, "HR");
    assert.deepEqual(
      Object.keys(res.body).sort(),
      ["active", "createdAt", "email", "employee", "id", "lastSeenAt", "pending", "role"],
      "the account answer carries a field nobody chose to publish",
    );
    assert.equal(res.body.pending, true, "an account nobody set a password for reads as in use");
    madeId = res.body.id;
  });

  it("lists the accounts of one role, and counts only those", async () => {
    const res = await request(http).get("/users?role=HR&take=200").set("Authorization", `Bearer ${admin}`);
    assert.equal(res.status, 200);
    const rows = res.body.rows as { email: string; role: string }[];
    assert.ok(rows.length > 0 && rows.every((row) => row.role === "HR"), "another role came back");
    assert.ok(rows.some((row) => row.email === MADE_EMAIL), "the account just made is missing");
    assert.equal(res.body.total, rows.length);
    const wrong = await request(http).get("/users?role=OWNER").set("Authorization", `Bearer ${admin}`);
    assert.equal(wrong.status, 400);
  });

  it("opens the account closed, with a link waiting and no password that works", async () => {
    const held = await db.user.findUniqueOrThrow({
      where: { email: MADE_EMAIL },
      select: { passwordHash: true, _count: { select: { passwordSetups: true } } },
    });
    assert.equal(held._count.passwordSetups, 1, "no setup link was minted for the new account");
    const res = await request(http)
      .post("/auth/login")
      .send({ email: MADE_EMAIL, password: MADE_PASSWORD });
    assert.equal(res.status, 401, "an account nobody has set a password for let somebody in");
  });

  it("lets it in once, and only once, after the link is spent", async () => {
    const link = randomBytes(32).toString("base64url");
    await db.passwordSetup.create({
      data: {
        userId: madeId,
        tokenHash: createHash("sha256").update(link).digest("hex"),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    const set = await request(http)
      .post("/auth/set-password")
      .send({ token: link, password: MADE_PASSWORD });
    assert.equal(set.status, 204, JSON.stringify(set.body));

    const inside = await request(http)
      .post("/auth/login")
      .send({ email: MADE_EMAIL, password: MADE_PASSWORD });
    assert.equal(inside.status, 200);

    const again = await request(http)
      .post("/auth/set-password")
      .send({ token: link, password: MADE_PASSWORD });
    assert.equal(again.status, 401, "a spent link set a password a second time");
  });

  it("refuses a password handed in on the create call", async () => {
    const res = await request(http)
      .post("/users")
      .set("Authorization", `Bearer ${admin}`)
      .send({ email: "typed@kiosk.local", role: "VIEWER", password: "a-long-enough-password" });
    assert.equal(res.status, 400, "an administrator was allowed to choose somebody's password");
  });

  it("mails the link again for an account that cannot recall its password", async () => {
    const before = await db.passwordSetup.count({ where: { userId: madeId } });
    const res = await request(http)
      .post(`/users/${madeId}/invite`)
      .set("Authorization", `Bearer ${admin}`);
    assert.equal(res.status, 204);
    const after = await db.passwordSetup.count({ where: { userId: madeId } });
    assert.equal(after, before + 1, "resending the invitation minted no new link");
  });

  it("refuses to delete an account somebody has signed in to", async () => {
    const res = await request(http)
      .delete(`/users/${madeId}`)
      .set("Authorization", `Bearer ${admin}`);
    assert.equal(res.status, 409);
    assert.equal(res.body.message, "ACCOUNT_HAS_HISTORY");
    assert.ok(await db.user.findUnique({ where: { id: madeId } }), "an account with a history was erased");
  });

  it("wrote down the changes an administrator made", async () => {
    const res = await request(http).get("/audit").set("Authorization", `Bearer ${admin}`);
    assert.equal(res.status, 200);
    const made = (res.body.rows as { action: string; subjectType: string; subjectId: string }[])
      .find((row) => row.action === "user.create" && row.subjectId === madeId);
    assert.ok(made, "creating an account left no trace in the audit log");
    assert.equal(made.subjectType, "user");
  });

  it("answers every error in one shape", async () => {
    const res = await request(http).get("/audit").set("Authorization", `Bearer ${viewer}`);
    assert.equal(res.status, 403);
    assert.equal(res.body.statusCode, 403);
    assert.equal(typeof res.body.path, "string");
    assert.equal(typeof res.body.ts, "string");
  });

  it("locks the account it made instead, and keeps the row", async () => {
    const res = await request(http)
      .patch(`/users/${madeId}`)
      .set("Authorization", `Bearer ${admin}`)
      .send({ active: false });
    assert.equal(res.status, 200);
    assert.equal(res.body.active, false);
    const inside = await request(http)
      .post("/auth/login")
      .send({ email: MADE_EMAIL, password: MADE_PASSWORD });
    assert.equal(inside.status, 401, "a locked account still signed in");
  });
});
