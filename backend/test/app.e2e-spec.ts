import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { hashPassword, verifyPassword } from "../src/modules/auth/password.js";
import { REFRESH_COOKIE } from "../src/modules/auth/auth.types.js";

// The last case spends the login allowance for the minute, so this suite needs
// an identity no parallel suite signs in as.
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
  // The allowance runs per minute over the whole suite, so the last case has
  // to know how much of it the cases above already used.
  let spent = 0;

  async function signIn(email: string, secret: string): Promise<request.Response> {
    spent += 1;
    return request(http).post("/auth/login").send({ email, password: secret });
  }

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
    const res = await signIn(SIGNER_EMAIL, "not-the-password");
    assert.equal(res.status, 401);
    assert.equal(res.body.message, "CREDENTIALS_REJECTED");
  });

  it("gives an unknown address the same answer as a wrong password", async () => {
    const res = await signIn("nobody@kiosk.local", "not-the-password");
    assert.equal(res.status, 401);
    assert.equal(res.body.message, "CREDENTIALS_REJECTED");
  });

  it("signs in, hands back an access token and sets an httpOnly refresh cookie", async () => {
    const res = await signIn(SIGNER_EMAIL, password);
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.accessToken, "string");
    assert.equal(res.body.email, SIGNER_EMAIL, "the account menu has no address to show");
    const jar = (res.headers["set-cookie"] ?? []) as unknown as string[];
    const line = jar.find((entry) => entry.startsWith(`${REFRESH_COOKIE}=`));
    assert.ok(line?.includes("HttpOnly"));
  });

  it("accepts the access token on a guarded route and reports the role", async () => {
    const login = await signIn(SIGNER_EMAIL, password);
    const me = await request(http)
      .get("/auth/me")
      .set("Authorization", `Bearer ${login.body.accessToken}`);
    assert.equal(me.status, 200);
    assert.equal(me.body.role, "HR");
    assert.equal(me.headers["cache-control"], "no-store", "a shared cache may keep a signed-in reply");
  });

  it("refuses a guarded route with no token", async () => {
    const res = await request(http).get("/auth/me");
    assert.equal(res.status, 401);
    assert.equal(res.body.message, "UNAUTHENTICATED", "passport's own word reached the client");
  });

  it("refuses a route the caller's role may not use with a code", async () => {
    const login = await signIn(SIGNER_EMAIL, password);
    const res = await request(http)
      .get("/releases")
      .set("Authorization", `Bearer ${login.body.accessToken}`);
    assert.equal(res.status, 403);
    assert.equal(res.body.message, "FORBIDDEN_ROLE", "Nest's own word reached the client");
  });

  it("refuses a body that is not JSON with a code, before any route reads it", async () => {
    const res = await request(http)
      .post("/employees")
      .set("Content-Type", "application/json")
      .send('{"code": "E2E", ');
    assert.equal(res.status, 400);
    assert.equal(res.body.message, "BODY_INVALID", "the parser's sentence reached the client");
  });

  it("refuses a body past the limit with 413 and a code, not a 500", async () => {
    const res = await request(http).post("/employees").send({ fullName: "x".repeat(200_000) });
    assert.equal(res.status, 413);
    assert.equal(res.body.message, "BODY_TOO_LARGE");
  });

  it("trades the refresh cookie for a new pair", async () => {
    const login = await signIn(SIGNER_EMAIL, password);
    const res = await request(http).post("/auth/refresh").set("Cookie", cookieFrom(login.headers));
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.accessToken, "string");
    assert.equal(res.body.email, SIGNER_EMAIL, "a reload loses the address the menu shows");
  });

  it("lets one of two renewals racing on one cookie win, and refuses the other", async () => {
    const login = await signIn(SIGNER_EMAIL, password);
    const held = cookieFrom(login.headers);
    const raced = await Promise.all([
      request(http).post("/auth/refresh").set("Cookie", held),
      request(http).post("/auth/refresh").set("Cookie", held),
    ]);
    assert.deepEqual(
      raced.map((res) => res.status).sort(),
      [200, 401],
      "both renewals of one refresh token came back with a pair",
    );
    assert.equal(raced.find((res) => res.status === 401)?.body.message, "REFRESH_REPLAYED");
  });

  it("finds the account whatever case the address is typed in", async () => {
    const res = await signIn(SIGNER_EMAIL.toUpperCase(), password);
    assert.equal(res.status, 200, "a phone keyboard's capital letter locked the owner out");
    assert.equal(res.body.email, SIGNER_EMAIL);
  });

  it("checks a password against no hash at all without ever matching", async () => {
    assert.equal(await verifyPassword(password, undefined), false);
    assert.equal(await verifyPassword(password, "none$"), false);
  });

  it("refuses a body it cannot accept with a code and the names of the fields", async () => {
    spent += 1;
    const res = await request(http)
      .post("/auth/login")
      .send({ email: "not-an-address", password, remember: true });
    assert.equal(res.status, 400);
    assert.equal(res.body.message, "VALIDATION_FAILED", "a validator sentence reached the client");
    assert.deepEqual([...(res.body.fields as string[])].sort(), ["email", "remember"]);
  });

  it("answers an id that is not a number with a code", async () => {
    const login = await signIn(SIGNER_EMAIL, password);
    const res = await request(http)
      .get("/employees/not-a-number")
      .set("Authorization", `Bearer ${login.body.accessToken}`);
    assert.equal(res.status, 400);
    assert.equal(res.body.message, "ID_INVALID");
    assert.equal(res.body.fields, undefined);
  });

  it("reads a large import body only for a caller holding a token this api signed", async () => {
    const big = { csv: "x".repeat(200_000) };
    const anonymous = await request(http).post("/employees/import").send(big);
    assert.equal(anonymous.status, 413, "an anonymous body was read before anyone asked who sent it");
    assert.equal(anonymous.body.message, "BODY_TOO_LARGE");

    const lapsed = new JwtService().sign(
      { sub: "e2e-lapsed", role: "HR", sid: "e2e-lapsed", exp: Math.floor(Date.now() / 1000) - 60 },
      { secret: validateEnv().JWT_ACCESS_SECRET },
    );
    const renewing = await request(http)
      .post("/employees/import")
      .set("Authorization", `Bearer ${lapsed}`)
      .send(big);
    assert.equal(renewing.status, 401, "an expired ticket lost the 401 that sends the browser to renew");
  });

  it("answers a route that does not exist with a code", async () => {
    const res = await request(http).get("/no-such-route");
    assert.equal(res.status, 404);
    assert.equal(res.body.message, "ROUTE_NOT_FOUND");
    assert.equal(res.body.path, "/no-such-route");
  });

  it("treats a refresh cookie used twice as a replay and drops the session", async () => {
    const login = await signIn(SIGNER_EMAIL, password);
    const used = cookieFrom(login.headers);
    const first = await request(http).post("/auth/refresh").set("Cookie", used);
    assert.equal(first.status, 200);

    const replay = await request(http).post("/auth/refresh").set("Cookie", used);
    assert.equal(replay.status, 401);

    // The session drops whole, so the token the replay raced dies with it.
    const after = await request(http)
      .post("/auth/refresh")
      .set("Cookie", cookieFrom(first.headers));
    assert.equal(after.status, 401);
  });

  // Declared last on purpose: it spends the login allowance for the minute.
  it("answers login exactly its own allowance of times, then stops", async () => {
    const allowance = validateEnv().LOGIN_ATTEMPTS_PER_MINUTE;
    let refused = false;
    for (let attempt = 0; attempt <= allowance + 2 && !refused; attempt += 1) {
      refused = (await signIn(SIGNER_EMAIL, "not-the-password")).status === 429;
    }
    assert.ok(refused, "the throttler never refused a login");
    // Counting refusals alone passes at any limit, including one raised by a
    // second bucket added somewhere else entirely.
    assert.equal(spent - 1, allowance, "login is answering to somebody else's allowance");
  });
});
