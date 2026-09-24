import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { GUARD } from "../src/common/cache/cache-keys.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { RedisService } from "../src/database/redis.service.js";
import { AuthService } from "../src/modules/auth/auth.service.js";
import { REFRESH_COOKIE } from "../src/modules/auth/auth.types.js";
import { hashPassword } from "../src/modules/auth/password.js";
import { UsersService } from "../src/modules/users/users.service.js";

const EMAIL = "e2esession@kiosk.local";
const FIRST_PASSWORD = "kiosk-e2e-password";
const NEXT_PASSWORD = "kiosk-e2e-password-two";
const PHONE = "e2e-phone/1.0";
const LAPTOP = "e2e-laptop/1.0";

interface Device {
  access: string;
  cookie: string;
}

function cookieFrom(headers: Record<string, unknown>): string {
  const jar = (headers["set-cookie"] ?? []) as unknown as string[];
  const found = jar.find((line) => line.startsWith(`${REFRESH_COOKIE}=`));
  assert.ok(found, "no refresh cookie was set");
  return found.split(";")[0];
}

describe("sessions across devices (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let auth: AuthService;
  let users: UsersService;
  let jwt: JwtService;
  let redis: RedisService;
  let userId = "";
  let phone: Device;
  let laptop: Device;

  async function live(): Promise<number> {
    return db.session.count({ where: { userId, revokedAt: null } });
  }

  // Sign in over http only where the route itself is what is under test: the
  // throttler counts every call and this suite would spend its own allowance.
  async function signIn(agent: string): Promise<Device> {
    const res = await request(http)
      .post("/auth/login")
      .set("User-Agent", agent)
      .send({ email: EMAIL, password: FIRST_PASSWORD });
    assert.equal(res.status, 200, `${agent} could not sign in`);
    return { access: res.body.accessToken as string, cookie: cookieFrom(res.headers) };
  }

  async function renew(device: Device): Promise<request.Response> {
    const res = await request(http).post("/auth/refresh").set("Cookie", device.cookie);
    if (res.status === 200) {
      device.access = res.body.accessToken as string;
      device.cookie = cookieFrom(res.headers);
    }
    return res;
  }

  before(async () => {
    void validateEnv();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    http = app.getHttpServer();
    db = app.get(PrismaService);
    auth = app.get(AuthService);
    users = app.get(UsersService);
    jwt = app.get(JwtService);
    redis = app.get(RedisService);
    await db.user.deleteMany({ where: { email: EMAIL } });
    const made = await db.user.create({
      data: { email: EMAIL, passwordHash: await hashPassword(FIRST_PASSWORD), role: "HR" },
    });
    userId = made.id;
  });

  after(async () => {
    await db.user.deleteMany({ where: { email: EMAIL } });
    await app.close();
  });

  it("gives a phone and a laptop a row each", async () => {
    phone = await signIn(PHONE);
    laptop = await signIn(LAPTOP);
    const rows = await db.session.findMany({ where: { userId, revokedAt: null } });
    assert.equal(rows.length, 2);
    assert.deepEqual(
      rows.map((one) => one.userAgent).sort(),
      [LAPTOP, PHONE].sort(),
      "the row does not say which device it belongs to",
    );
  });

  it("renews both of them, which one cell could not do", async () => {
    assert.equal((await renew(phone)).status, 200);
    assert.equal(
      (await renew(laptop)).status,
      200,
      "the second device lost its session to the first",
    );
  });

  it("spends a replay on one device without touching the other", async () => {
    const spent = phone.cookie;
    assert.equal((await renew(phone)).status, 200);

    const replay = await request(http).post("/auth/refresh").set("Cookie", spent);
    assert.equal(replay.status, 401);
    assert.equal(replay.body.message, "REFRESH_REPLAYED");
    assert.equal((await renew(phone)).status, 401, "the replayed device kept its session");

    assert.equal(
      (await renew(laptop)).status,
      200,
      "one device's replay signed the other one out",
    );
  });

  it("closes the device that asks to log out and no other", async () => {
    await auth.signIn(EMAIL, FIRST_PASSWORD, { userAgent: "e2e-desk/1.0" });
    assert.equal(await live(), 2);

    const out = await request(http)
      .post("/auth/logout")
      .set("Authorization", `Bearer ${laptop.access}`);
    assert.equal(out.status, 204);
    assert.equal((await renew(laptop)).status, 401);
    assert.equal(await live(), 1, "logging out on one device closed another");
  });

  it("signs every device out when the password changes", async () => {
    await auth.signIn(EMAIL, FIRST_PASSWORD, { userAgent: "e2e-a/1.0" });
    await auth.signIn(EMAIL, FIRST_PASSWORD, { userAgent: "e2e-b/1.0" });
    assert.ok((await live()) >= 2);

    // The only way a password is ever set is a one-time link, so the test
    // mints one the way provisioning does and spends it.
    const link = randomBytes(32).toString("base64url");
    await db.passwordSetup.create({
      data: {
        userId,
        tokenHash: createHash("sha256").update(link).digest("hex"),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    await auth.setPassword(link, NEXT_PASSWORD);
    assert.equal(await live(), 0, "a password nobody else knows left a device signed in");
  });

  it("ends an account's access tokens the moment its role changes", async () => {
    const email = "e2e-sessions-demoted@kiosk.local";
    await db.user.deleteMany({ where: { email } });
    const made = await db.user.create({
      data: { email, passwordHash: await hashPassword(FIRST_PASSWORD), role: "HR" },
    });
    const held = await auth.signIn(email, FIRST_PASSWORD, { userAgent: "e2e-demoted/1.0" });
    const me = (token: string) => request(http).get("/auth/me").set("Authorization", `Bearer ${token}`);
    assert.equal((await me(held.accessToken)).status, 200);

    await users.update(userId, made.id, { role: "VIEWER" });
    assert.equal((await me(held.accessToken)).status, 401, "a demoted account kept using its old token");
    assert.equal(await db.session.count({ where: { userId: made.id, revokedAt: null } }), 0);

    const fresh = await auth.signIn(email, FIRST_PASSWORD, { userAgent: "e2e-demoted/1.0" });
    assert.equal((await me(fresh.accessToken)).status, 200, "the account could not sign in again");
    await db.user.deleteMany({ where: { email } });
  });

  it("settles a token from the cutoff's own second by whether its session is open", async () => {
    const held = await auth.signIn(EMAIL, NEXT_PASSWORD, { userAgent: "e2e-same-second/1.0" });
    const claims = jwt.decode(held.accessToken) as { iat: number; sid: string };
    const me = () => request(http).get("/auth/me").set("Authorization", `Bearer ${held.accessToken}`);
    await redis.client.set(GUARD.accessCutoff(userId), String(claims.iat), "EX", 60);
    try {
      assert.equal((await me()).status, 200, "a sign-in in the cutoff's second got a dead token");
      await auth.close(claims.sid);
      assert.equal((await me()).status, 401, "a closed session's token outlived the cutoff");
    } finally {
      await redis.client.del(GUARD.accessCutoff(userId));
    }
  });

  it("holds no more devices than it is allowed to", async () => {
    const cap = validateEnv().SESSIONS_PER_USER;
    for (let opened = 0; opened < cap + 2; opened += 1) {
      await auth.signIn(EMAIL, NEXT_PASSWORD, { userAgent: `e2e-many-${opened}` });
    }
    assert.equal(await live(), cap, "an account piles up rows without a ceiling");
  });
});
