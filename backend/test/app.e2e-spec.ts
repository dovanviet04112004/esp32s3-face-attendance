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
import { REFRESH_COOKIE } from "../src/modules/auth/auth.types.js";

// One account holds one refresh token (KEHOACH 9.23 rule 5), so this suite
// needs an identity no parallel suite signs in as.
const SIGNER_EMAIL = "e2eauth@kiosk.local";
const SIGNER_PASSWORD = "kiosk-e2e-password";

function cookieFrom(headers: Record<string, unknown>): string {
  const jar = (headers["set-cookie"] ?? []) as unknown as string[];
  const found = jar.find((line) => line.startsWith(`${REFRESH_COOKIE}=`));
  assert.ok(found, "no refresh cookie was set");
  return found.split(";")[0];
}

describe("auth (e2e)", () => {
  let app: INestApplication;
  let password: string;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;

  before(async () => {
    password = SIGNER_PASSWORD;
    void validateEnv();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    http = app.getHttpServer();
    db = app.get(PrismaService);
    await db.user.deleteMany({ where: { email: SIGNER_EMAIL } });
    await db.user.create({
      data: { email: SIGNER_EMAIL, passwordHash: await hashPassword(password), role: "HR" },
    });
  });

  after(async () => {
    await db.user.deleteMany({ where: { email: SIGNER_EMAIL } });
    await app.close();
  });

  it("refuses a wrong password without saying which half was wrong", async () => {
    const res = await request(http)
      .post("/auth/login")
      .send({ email: SIGNER_EMAIL, password: "not-the-password" });
    assert.equal(res.status, 401);
    assert.equal(res.body.message, "CREDENTIALS_REJECTED");
  });

  it("gives an unknown address the same answer as a wrong password", async () => {
    const res = await request(http)
      .post("/auth/login")
      .send({ email: "nobody@kiosk.local", password: "not-the-password" });
    assert.equal(res.status, 401);
    assert.equal(res.body.message, "CREDENTIALS_REJECTED");
  });

  it("signs in, hands back an access token and sets an httpOnly refresh cookie", async () => {
    const res = await request(http).post("/auth/login").send({ email: SIGNER_EMAIL, password });
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.accessToken, "string");
    const jar = (res.headers["set-cookie"] ?? []) as unknown as string[];
    const line = jar.find((entry) => entry.startsWith(`${REFRESH_COOKIE}=`));
    assert.ok(line?.includes("HttpOnly"));
  });

  it("accepts the access token on a guarded route and reports the role", async () => {
    const login = await request(http).post("/auth/login").send({ email: SIGNER_EMAIL, password });
    const me = await request(http)
      .get("/auth/me")
      .set("Authorization", `Bearer ${login.body.accessToken}`);
    assert.equal(me.status, 200);
    assert.equal(me.body.role, "HR");
  });

  it("refuses a guarded route with no token", async () => {
    const res = await request(http).get("/auth/me");
    assert.equal(res.status, 401);
  });

  it("trades the refresh cookie for a new pair", async () => {
    const login = await request(http).post("/auth/login").send({ email: SIGNER_EMAIL, password });
    const res = await request(http).post("/auth/refresh").set("Cookie", cookieFrom(login.headers));
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.accessToken, "string");
  });

  it("treats a refresh cookie used twice as a replay and drops the session", async () => {
    const login = await request(http).post("/auth/login").send({ email: SIGNER_EMAIL, password });
    const spent = cookieFrom(login.headers);
    const first = await request(http).post("/auth/refresh").set("Cookie", spent);
    assert.equal(first.status, 200);

    const replay = await request(http).post("/auth/refresh").set("Cookie", spent);
    assert.equal(replay.status, 401);

    // The session drops whole, so the token the replay raced dies with it.
    const after = await request(http)
      .post("/auth/refresh")
      .set("Cookie", cookieFrom(first.headers));
    assert.equal(after.status, 401);
  });

  // Declared last on purpose: it spends the login allowance for the minute.
  it("stops answering login once the allowance for the minute is gone", async () => {
    const allowance = validateEnv().LOGIN_ATTEMPTS_PER_MINUTE;
    let refused = 0;
    for (let attempt = 0; attempt <= allowance + 1; attempt += 1) {
      const res = await request(http)
        .post("/auth/login")
        .send({ email: SIGNER_EMAIL, password: "not-the-password" });
      if (res.status === 429) {
        refused += 1;
      }
    }
    assert.ok(refused > 0, "the throttler never refused a login");
  });
});
