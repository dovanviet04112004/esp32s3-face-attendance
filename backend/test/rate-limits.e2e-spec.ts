import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import type { PrismaService } from "../src/database/prisma.service.js";

const API_LIMIT = 8;
const HEAVY_LIMIT = 2;
const LOCK_AFTER = 3;
const PASSWORD = "e2e-limits-password";
const RUN = randomUUID().slice(0, 8);

// ConfigModule reads the environment as AppModule is declared, so these go in first.
Object.assign(process.env, {
  API_REQUESTS_PER_MINUTE: String(API_LIMIT),
  HEAVY_REQUESTS_PER_MINUTE: String(HEAVY_LIMIT),
  LOGIN_LOCK_AFTER: String(LOCK_AFTER),
  LOGIN_ATTEMPTS_PER_MINUTE: "1000",
  TRUST_PROXY_HOPS: "1",
});

describe("rate limits and account lockout (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let address = 0;
  const emails: string[] = [];

  // Each request from its own address, so the per-address buckets never decide a case.
  function fresh(): string {
    address += 1;
    return `198.51.100.${address % 250}`;
  }

  async function account(name: string, role: "ADMIN" | "VIEWER" = "VIEWER"): Promise<string> {
    const { hashPassword } = await import("../src/modules/auth/password.js");
    const email = `e2e-limits-${name}-${RUN}@kiosk.local`;
    emails.push(email);
    await db.user.create({ data: { email, role, passwordHash: await hashPassword(PASSWORD) } });
    return email;
  }

  function login(email: string, password = PASSWORD): request.Test {
    return request(http).post("/auth/login").set("X-Forwarded-For", fresh()).send({ email, password });
  }

  async function token(email: string): Promise<string> {
    const res = await login(email);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body.accessToken as string;
  }

  function asAccount(bearer: string, path: string): request.Test {
    return request(http).get(path).set("Authorization", `Bearer ${bearer}`).set("X-Forwarded-For", fresh());
  }

  before(async () => {
    const { AppModule } = await import("../src/app.module.js");
    const { configure } = await import("../src/bootstrap.js");
    const { PrismaService } = await import("../src/database/prisma.service.js");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    http = app.getHttpServer();
    db = app.get(PrismaService);
  });

  after(async () => {
    await db.user.deleteMany({ where: { email: { in: emails } } });
    await app.close();
  });

  it("serves one account its allowance and answers the next call RATE_LIMITED", async () => {
    const bearer = await token(await account("steady"));
    for (let call = 0; call < API_LIMIT; call += 1) {
      assert.equal((await asAccount(bearer, "/auth/me")).status, 200, `call ${call + 1} was refused`);
    }
    const over = await asAccount(bearer, "/auth/me");
    assert.equal(over.status, 429, "an account ran past its allowance");
    assert.equal(over.body.message, "RATE_LIMITED");
  });

  it("counts by the account, so a fresh address does not buy a spent account more calls", async () => {
    const bearer = await token(await account("roaming"));
    for (let call = 0; call < API_LIMIT; call += 1) {
      await asAccount(bearer, "/auth/me");
    }
    assert.equal((await asAccount(bearer, "/auth/me")).status, 429);
  });

  it("gives every account its own allowance", async () => {
    const first = await token(await account("first"));
    const second = await token(await account("second"));
    for (let call = 0; call <= API_LIMIT; call += 1) {
      await asAccount(first, "/auth/me");
    }
    assert.equal((await asAccount(second, "/auth/me")).status, 200, "one account spent another's allowance");
  });

  it("holds heavy work to its own tighter allowance", async () => {
    const bearer = await token(await account("exporter", "ADMIN"));
    for (let call = 0; call < HEAVY_LIMIT; call += 1) {
      assert.equal((await asAccount(bearer, "/employees/export")).status, 200);
    }
    const over = await asAccount(bearer, "/employees/export");
    assert.equal(over.status, 429, "an export ran past the heavy allowance");
    assert.equal((await asAccount(bearer, "/auth/me")).status, 200, "the heavy bucket spent the general one");
  });

  it("locks an email after its misses in a row, whatever address they come from", async () => {
    const email = await account("guessed");
    for (let miss = 0; miss < LOCK_AFTER; miss += 1) {
      assert.equal((await login(email, "not-the-password")).status, 401);
    }
    const locked = await login(email);
    assert.equal(locked.status, 429, "the right password still opened a locked account");
    assert.equal(locked.body.message, "AUTH_LOCKED");
  });

  it("locks an email nobody owns just the same, so a lock names no account", async () => {
    const email = `e2e-limits-nobody-${RUN}@kiosk.local`;
    for (let miss = 0; miss < LOCK_AFTER; miss += 1) {
      assert.equal((await login(email, "not-the-password")).status, 401);
    }
    assert.equal((await login(email, "not-the-password")).body.message, "AUTH_LOCKED");
  });

  it("forgets the misses once the owner signs in", async () => {
    const email = await account("forgetful");
    for (let miss = 0; miss < LOCK_AFTER - 1; miss += 1) {
      await login(email, "not-the-password");
    }
    assert.equal((await login(email)).status, 200);
    for (let miss = 0; miss < LOCK_AFTER - 1; miss += 1) {
      await login(email, "not-the-password");
    }
    assert.equal((await login(email)).status, 200, "misses from before a good sign-in still counted");
  });
});
