import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { RATE } from "../src/common/cache/cache-keys.js";
import type { PrismaService } from "../src/database/prisma.service.js";
import type { RedisService } from "../src/database/redis.service.js";
import { THROTTLE } from "../src/modules/auth/auth.types.js";

const API_LIMIT = 8;
const HEAVY_LIMIT = 2;
const SEARCH_LIMIT = 3;
const LOGIN_LIMIT = 6;
const ADDRESS_MISSES = 4;
const REGISTER_LIMIT = 3;
const LOCK_AFTER = 3;
const PASSWORD = "e2e-limits-password";
const RUN = randomUUID().slice(0, 8);

// ConfigModule reads the environment as AppModule is declared, so these go in first.
Object.assign(process.env, {
  API_REQUESTS_PER_MINUTE: String(API_LIMIT),
  HEAVY_REQUESTS_PER_MINUTE: String(HEAVY_LIMIT),
  SEARCH_REQUESTS_PER_MINUTE: String(SEARCH_LIMIT),
  LOGIN_ATTEMPTS_PER_MINUTE: String(LOGIN_LIMIT),
  LOGIN_IP_MISSES: String(ADDRESS_MISSES),
  DEVICE_REGISTER_ATTEMPTS_PER_MINUTE: String(REGISTER_LIMIT),
  LOGIN_LOCK_AFTER: String(LOCK_AFTER),
  TRUST_PROXY_HOPS: "1",
});

// A /64 of its own per case and per run: the counters live in Redis and outlast the process.
function network(caseNo: number, host = 1): string {
  return `2001:db8:${RUN.slice(0, 4)}:${caseNo}::${host}`;
}

describe("rate limits and account lockout (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let redis: RedisService;
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

  function login(email: string, password = PASSWORD, from = fresh()): request.Test {
    return request(http).post("/auth/login").set("X-Forwarded-For", from).send({ email, password });
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
    const { RedisService } = await import("../src/database/redis.service.js");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    http = app.getHttpServer();
    db = app.get(PrismaService);
    redis = app.get(RedisService);
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

  it("counts one allowance over every route, not one per route", async () => {
    const bearer = await token(await account("wandering"));
    for (let call = 0; call < API_LIMIT; call += 1) {
      const path = call % 2 === 0 ? "/auth/me" : "/notifications/unread";
      assert.equal((await asAccount(bearer, path)).status, 200, `call ${call + 1} was refused`);
    }
    assert.equal((await asAccount(bearer, "/auth/me")).status, 429, "a second route bought more calls");
  });

  it("counts every heavy route against the one heavy allowance", async () => {
    const bearer = await token(await account("collector", "ADMIN"));
    assert.equal((await asAccount(bearer, "/employees/export")).status, 200);
    assert.equal((await asAccount(bearer, "/assets/export")).status, 200);
    const over = await asAccount(bearer, "/employees/export");
    assert.equal(over.status, 429, "a second heavy route bought more exports");
  });

  it("holds search to its own allowance and leaves the general one standing", async () => {
    const bearer = await token(await account("searcher", "ADMIN"));
    for (let call = 0; call < SEARCH_LIMIT; call += 1) {
      assert.equal((await asAccount(bearer, "/search?q=nguyen")).status, 200, `search ${call + 1} was refused`);
    }
    assert.equal((await asAccount(bearer, "/search?q=nguyen")).status, 429);
    assert.equal((await asAccount(bearer, "/auth/me")).status, 200, "search spent the general allowance");
  });

  it("answers the password doors their allowance per address, then stops, for good passwords too", async () => {
    const email = await account("office");
    for (let attempt = 0; attempt < LOGIN_LIMIT; attempt += 1) {
      assert.equal((await login(email, PASSWORD, network(1))).status, 200, `sign-in ${attempt + 1} was refused`);
    }
    const over = await login(email, PASSWORD, network(1));
    assert.equal(over.status, 429);
    assert.equal(over.body.message, "RATE_LIMITED");
    assert.equal((await login(email, PASSWORD, network(2))).status, 200, "one address spent another's allowance");
  });

  it("counts one IPv6 /64 as one caller, so walking its addresses buys nothing", async () => {
    const email = await account("rotating");
    for (let attempt = 0; attempt < LOGIN_LIMIT; attempt += 1) {
      await login(email, PASSWORD, network(3, attempt + 1));
    }
    assert.equal((await login(email, PASSWORD, network(3, 99))).status, 429);
  });

  it("closes an address that misses over many emails, and only that address", async () => {
    const email = await account("sprayed");
    for (let miss = 0; miss < ADDRESS_MISSES; miss += 1) {
      const other = `e2e-limits-spray-${miss}-${RUN}@kiosk.local`;
      assert.equal((await login(other, "not-the-password", network(4))).status, 401);
    }
    const closed = await login(email, PASSWORD, network(4));
    assert.equal(closed.status, 429, "an address kept guessing across accounts");
    assert.equal(closed.body.message, "RATE_LIMITED", "the account itself was reported as locked");
    assert.equal((await login(email, PASSWORD, network(5))).status, 200, "the account paid for another address");
  });

  it("does not let good sign-ins from an address wash out its misses", async () => {
    const email = await account("washed");
    for (let miss = 0; miss < ADDRESS_MISSES - 1; miss += 1) {
      await login(`e2e-limits-wash-${miss}-${RUN}@kiosk.local`, "not-the-password", network(6));
    }
    assert.equal((await login(email, PASSWORD, network(6))).status, 200, "misses short of the limit closed it");
    await login(`e2e-limits-wash-last-${RUN}@kiosk.local`, "not-the-password", network(6));
    assert.equal((await login(email, PASSWORD, network(6))).status, 429, "a good sign-in reset the address");
  });

  it("answers the kiosk register door its allowance per address", async () => {
    const ask = () =>
      request(http).post("/devices/register").set("X-Forwarded-For", network(7)).send({ deviceId: "nobody" });
    for (let call = 0; call < REGISTER_LIMIT; call += 1) {
      assert.notEqual((await ask()).status, 429, `ask ${call + 1} was refused`);
    }
    assert.equal((await ask()).status, 429, "a machine could ask without limit");
  });

  it("keeps the count in Redis, where a restart or a second api reads the same number", async () => {
    const email = await account("counted");
    const bearer = await token(email);
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    for (let call = 0; call < 3; call += 1) {
      await asAccount(bearer, "/auth/me");
    }
    assert.equal(Number(await redis.client.get(RATE.hits(THROTTLE.api, `user:${user.id}`))), 3);
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

  it("counts misses typed in any case against the one address", async () => {
    const email = await account("shouted");
    const spellings = [email.toUpperCase(), email, `${email[0].toUpperCase()}${email.slice(1)}`];
    for (const typed of spellings.slice(0, LOCK_AFTER)) {
      assert.equal((await login(typed, "not-the-password")).status, 401);
    }
    const locked = await login(email);
    assert.equal(locked.status, 429, "changing the case of the address bought more guesses");
    assert.equal(locked.body.message, "AUTH_LOCKED");
  });

  it("locks the account against a held session guessing the password it would change", async () => {
    const email = await account("hijacked");
    const bearer = await token(email);
    const change = (current: string): request.Test =>
      request(http)
        .post("/auth/change-password")
        .set("Authorization", `Bearer ${bearer}`)
        .set("X-Forwarded-For", fresh())
        .send({ current, next: "a-new-long-password" });
    for (let miss = 0; miss < LOCK_AFTER; miss += 1) {
      assert.equal((await change("not-the-password")).status, 401);
    }
    const locked = await change(PASSWORD);
    assert.equal(locked.status, 429, "a session kept guessing past the lock");
    assert.equal(locked.body.message, "AUTH_LOCKED");
    assert.equal((await login(email)).body.message, "AUTH_LOCKED", "the login door did not share the lock");
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

  // Last: it takes Redis away from this process and brings it back.
  it("keeps answering at once while Redis is away, with the limits open", async () => {
    const email = await account("unwatched");
    const bearer = await token(email);
    redis.client.disconnect();
    try {
      const started = Date.now();
      for (let call = 0; call <= API_LIMIT; call += 1) {
        assert.equal((await asAccount(bearer, "/auth/me")).status, 200, `call ${call + 1} failed without Redis`);
      }
      assert.equal((await login(email)).status, 200, "sign-in needed Redis");
      assert.ok(Date.now() - started < 3000, "requests waited for Redis to come back");
    } finally {
      await redis.client.connect();
    }
  });
});
