import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import type { Role } from "@prisma/client";
import { io } from "socket.io-client";
import request from "supertest";

import type { PrismaService } from "../src/database/prisma.service.js";
import { REFRESH_COOKIE } from "../src/modules/auth/auth.types.js";
import { codeAt, stepAt } from "../src/modules/auth/totp.js";

const RUN = randomUUID().slice(0, 8);
const PASSWORD = "e2e-mfa-password-long";
const LOCK_AFTER = 3;
const MFA_BUCKET = 6;
const SETTLE_MS = 300;
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

// ConfigModule reads the environment as AppModule is declared, so these go in first.
Object.assign(process.env, {
  MFA_ROLES: "ADMIN,HR,PAYROLL",
  MFA_KEY: Buffer.alloc(32, 7).toString("base64"),
  MFA_LOCK_AFTER: String(LOCK_AFTER),
  MFA_ATTEMPTS_PER_MINUTE: String(MFA_BUCKET),
  TRUST_PROXY_HOPS: "1",
});

interface Enrolled {
  id: string;
  email: string;
  secret: Buffer;
  backupCodes: string[];
  access: string;
}

function fromBase32(text: string): Buffer {
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const char of text) {
    value = ((value << 5) | BASE32.indexOf(char)) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

// The code an authenticator shows this many steps from now.
function codeFor(secret: Buffer, offset = 0): string {
  return codeAt(secret, stepAt(Date.now()) + offset);
}

function wrongFor(secret: Buffer): string {
  const near = [-1, 0, 1].map((offset) => codeFor(secret, offset));
  return ["000000", "111111", "222222", "333333"].find((one) => !near.includes(one)) as string;
}

function claimsOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("two-step sign-in for the desk roles (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let jwt: JwtService;
  let accessSecret = "";
  let port = 0;
  let address = 0;
  const emails: string[] = [];
  const ids: string[] = [];

  // Each request from its own address, so the per-address bucket decides only its own case.
  function fresh(): string {
    address += 1;
    return `198.51.101.${address % 250}`;
  }

  async function account(name: string, role: Role): Promise<{ id: string; email: string }> {
    const { hashPassword } = await import("../src/modules/auth/password.js");
    const email = `e2e-mfa-${name}-${RUN}@kiosk.local`;
    const made = await db.user.create({ data: { email, role, passwordHash: await hashPassword(PASSWORD) } });
    emails.push(email);
    ids.push(made.id);
    return { id: made.id, email };
  }

  function post(path: string, body: object, from = fresh()): request.Test {
    return request(http).post(path).set("X-Forwarded-For", from).send(body);
  }

  async function ticket(email: string, step: "code" | "enroll"): Promise<string> {
    const res = await post("/auth/login", { email, password: PASSWORD });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.step, step);
    return res.body.challenge as string;
  }

  async function enroll(name: string, role: Role): Promise<Enrolled> {
    const { id, email } = await account(name, role);
    const challenge = await ticket(email, "enroll");
    const offer = await post("/auth/mfa/setup", { challenge });
    assert.equal(offer.status, 200, JSON.stringify(offer.body));
    const secret = fromBase32(offer.body.secret as string);
    const done = await post("/auth/mfa/confirm", { challenge, code: codeFor(secret) });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    return { id, email, secret, backupCodes: done.body.backupCodes as string[], access: done.body.accessToken as string };
  }

  async function verify(email: string, code: string): Promise<request.Response> {
    return post("/auth/mfa/verify", { challenge: await ticket(email, "code"), code });
  }

  function trail(subjectId: string, action: string) {
    return db.auditLog.findMany({ where: { subjectType: "user", subjectId, action } });
  }

  before(async () => {
    const { AppModule } = await import("../src/app.module.js");
    const { configure } = await import("../src/bootstrap.js");
    const { PrismaService } = await import("../src/database/prisma.service.js");
    const { validateEnv } = await import("../src/config/env.schema.js");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    await app.listen(0);
    port = (app.getHttpServer().address() as { port: number }).port;
    http = app.getHttpServer();
    db = app.get(PrismaService);
    jwt = app.get(JwtService);
    accessSecret = validateEnv().JWT_ACCESS_SECRET;
  });

  after(async () => {
    await db.auditLog.deleteMany({ where: { subjectType: "user", subjectId: { in: ids } } });
    await db.user.deleteMany({ where: { email: { in: emails } } });
    await app.close();
  });

  it("computes the codes of RFC 6238 appendix B", () => {
    const secret = Buffer.from("12345678901234567890");
    const vectors: [number, string][] = [
      [59, "94287082"],
      [1111111109, "07081804"],
      [1111111111, "14050471"],
      [1234567890, "89005924"],
      [2000000000, "69279037"],
      [20000000000, "65353130"],
    ];
    for (const [seconds, code] of vectors) {
      assert.equal(codeAt(secret, stepAt(seconds * 1000), 8), code, `T=${seconds}`);
    }
  });

  it("answers a desk role's right password with a ticket, and no token, cookie or session", async () => {
    const { id, email } = await account("ticket", "HR");
    const res = await post("/auth/login", { email, password: PASSWORD });
    assert.equal(res.status, 200);
    assert.equal(res.body.step, "enroll");
    assert.equal(typeof res.body.challenge, "string");
    assert.equal(res.body.accessToken, undefined, "a password alone earned an access token");
    const jar = (res.headers["set-cookie"] ?? []) as unknown as string[];
    assert.ok(!jar.some((line) => line.startsWith(`${REFRESH_COOKIE}=`)), "a password alone earned a refresh cookie");
    assert.equal(await db.session.count({ where: { userId: id } }), 0, "a password alone opened a session");
    const asBearer = await request(http).get("/auth/me").set("Authorization", `Bearer ${res.body.challenge}`);
    assert.equal(asBearer.status, 401, "the ticket passed as an access token");
  });

  it("lets an employee in on the password alone", async () => {
    const { email } = await account("plain", "EMPLOYEE");
    const res = await post("/auth/login", { email, password: PASSWORD });
    assert.equal(res.status, 200);
    assert.equal(res.body.step, "session");
    assert.equal(claimsOf(res.body.accessToken as string).mfa, undefined);
  });

  it("enrols on the first code, seals the secret and hands out ten backup codes once", async () => {
    const { id, email } = await account("enrol", "PAYROLL");
    const challenge = await ticket(email, "enroll");
    const offer = await post("/auth/mfa/setup", { challenge });
    assert.equal(offer.status, 200);
    const secret = fromBase32(offer.body.secret as string);
    assert.equal(secret.length, 20, "the secret is not 160 bits");
    const uri = new URL(offer.body.uri as string);
    assert.equal(uri.protocol, "otpauth:");
    assert.equal(uri.searchParams.get("secret"), offer.body.secret);
    assert.equal(uri.searchParams.get("digits"), "6");
    assert.equal(uri.searchParams.get("period"), "30");

    const wrong = await post("/auth/mfa/confirm", { challenge, code: wrongFor(secret) });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.message, "MFA_CODE_REJECTED");
    assert.equal((await db.userMfa.findUniqueOrThrow({ where: { userId: id } })).secret, null, "a wrong code kept the secret");

    const done = await post("/auth/mfa/confirm", { challenge, code: codeFor(secret) });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(claimsOf(done.body.accessToken as string).mfa, true);
    const codes = done.body.backupCodes as string[];
    assert.equal(codes.length, 10);
    assert.equal(new Set(codes).size, 10);
    assert.ok(codes.every((one) => /^[2-9a-hjkmnp-z]{5}-[2-9a-hjkmnp-z]{5}$/.test(one)), codes.join(" "));

    const held = await db.userMfa.findUniqueOrThrow({ where: { userId: id } });
    assert.ok(held.secret && !Buffer.from(held.secret).includes(secret), "the secret sits in the row unsealed");
    assert.equal(held.pendingSecret, null);
    assert.ok(held.backupCodes.every((one) => /^[0-9a-f]{64}$/.test(one)), "a backup code sits in the row as typed");
    assert.ok(!held.backupCodes.some((one) => codes.includes(one)));
    const session = await db.session.findFirstOrThrow({ where: { userId: id } });
    assert.ok(session.mfaAt, "the session does not say it gave a code");
    assert.equal((await trail(id, "user.mfaOn")).length, 1);

    const again = await post("/auth/mfa/setup", { challenge: await ticket(email, "code") });
    assert.equal(again.status, 409);
    assert.equal(again.body.message, "MFA_ALREADY_ON");
  });

  it("refuses a code used once, even inside its window", async () => {
    const one = await enroll("replay", "HR");
    const next = codeFor(one.secret, 1);
    const first = await verify(one.email, next);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(claimsOf(first.body.accessToken as string).mfa, true);
    const replay = await verify(one.email, next);
    assert.equal(replay.status, 401, "a used code opened a second session");
    assert.equal(replay.body.message, "MFA_CODE_REJECTED");
    const older = await verify(one.email, codeFor(one.secret, 0));
    assert.equal(older.status, 401, "a code older than the last one passed");
  });

  it("takes each backup code once, typed loosely", async () => {
    const one = await enroll("backup", "HR");
    const first = await verify(one.email, one.backupCodes[0]);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const used = await trail(one.id, "user.mfaBackup");
    assert.equal(used.length, 1);
    assert.deepEqual(used[0].meta, { left: 9 });
    const again = await verify(one.email, one.backupCodes[0]);
    assert.equal(again.status, 401, "a backup code worked twice");
    const loose = ` ${one.backupCodes[1].toUpperCase().replace("-", " - ")} `;
    assert.equal((await verify(one.email, loose)).status, 200, "spaces, dashes and capitals refused a good code");
    assert.equal((await db.userMfa.findUniqueOrThrow({ where: { userId: one.id } })).backupCodes.length, 8);
  });

  it("locks the code step after wrong codes, even for the right one, and tells the trail", async () => {
    const one = await enroll("lock", "HR");
    const challenge = await ticket(one.email, "code");
    for (let miss = 0; miss < LOCK_AFTER; miss += 1) {
      const res = await post("/auth/mfa/verify", { challenge, code: wrongFor(one.secret) });
      assert.equal(res.status, 401, `miss ${miss + 1}`);
    }
    const right = await post("/auth/mfa/verify", { challenge, code: codeFor(one.secret, 1) });
    assert.equal(right.status, 429, "the right code passed a locked step");
    assert.equal(right.body.message, "MFA_LOCKED");
    assert.equal((await trail(one.id, "user.mfaLocked")).length, 1);

    await db.userMfa.update({ where: { userId: one.id }, data: { lockedUntil: new Date(Date.now() - 1000) } });
    const later = await post("/auth/mfa/verify", { challenge, code: codeFor(one.secret, 1) });
    assert.equal(later.status, 200, "the lock outlived its window");
    assert.equal((await db.userMfa.findUniqueOrThrow({ where: { userId: one.id } })).misses, 0);
  });

  it("keeps a desk token without the code off the API and the feed", async () => {
    const one = await enroll("token", "HR");
    const bare = jwt.sign({ sub: one.id, role: "HR", sid: randomUUID() }, { secret: accessSecret, expiresIn: "5m" });
    const refused = await request(http).get("/auth/me").set("Authorization", `Bearer ${bare}`);
    assert.equal(refused.status, 401);
    assert.equal(refused.body.message, "MFA_REQUIRED");
    const allowed = await request(http).get("/auth/me").set("Authorization", `Bearer ${one.access}`);
    assert.equal(allowed.status, 200);

    for (const [token, open] of [
      [bare, false],
      [one.access, true],
    ] as const) {
      const socket = io(`http://127.0.0.1:${port}/feed`, { transports: ["websocket"], reconnection: false, auth: { token } });
      await new Promise<void>((done) => {
        socket.on("connect", () => done());
        socket.on("connect_error", () => done());
      });
      await new Promise((done) => setTimeout(done, SETTLE_MS));
      assert.equal(socket.connected, open, open ? "a token with its code lost the feed" : "a token without its code kept the feed");
      socket.close();
    }
  });

  it("refuses to renew a session that never gave a code once its role asks for one", async () => {
    const { id, email } = await account("promoted", "EMPLOYEE");
    const res = await post("/auth/login", { email, password: PASSWORD });
    assert.equal(res.body.step, "session");
    const jar = (res.headers["set-cookie"] ?? []) as unknown as string[];
    const cookie = (jar.find((line) => line.startsWith(`${REFRESH_COOKIE}=`)) as string).split(";")[0];
    await db.user.update({ where: { id }, data: { role: "HR" } });
    const renewed = await request(http).post("/auth/refresh").set("Cookie", cookie);
    assert.equal(renewed.status, 401);
    assert.equal(renewed.body.message, "MFA_REQUIRED");
    assert.equal(await db.session.count({ where: { userId: id, revokedAt: null } }), 0, "the password-only session stayed open");
  });

  it("restarts at the password when the ticket is forged, foreign or outlived its role", async () => {
    const one = await enroll("ticket-life", "HR");
    const code = codeFor(one.secret, 1);
    const forged = jwt.sign({ typ: "mfa" }, { secret: accessSecret, subject: one.id, expiresIn: "5m" });
    for (const challenge of ["not-a-ticket", forged, one.access]) {
      const res = await post("/auth/mfa/verify", { challenge, code });
      assert.equal(res.status, 401);
      assert.equal(res.body.message, "MFA_CHALLENGE_SPENT");
    }
    const challenge = await ticket(one.email, "code");
    await db.user.update({ where: { id: one.id }, data: { role: "EMPLOYEE" } });
    const demoted = await post("/auth/mfa/verify", { challenge, code });
    assert.equal(demoted.body.message, "MFA_CHALLENGE_SPENT", "a ticket outlived the role that asked for it");
  });

  it("trades a working code for new backup codes and retires the old set", async () => {
    const one = await enroll("renew", "HR");
    const asked = (code: string) =>
      request(http)
        .post("/auth/mfa/backup-codes")
        .set("Authorization", `Bearer ${one.access}`)
        .set("X-Forwarded-For", fresh())
        .send({ code });
    assert.equal((await asked(wrongFor(one.secret))).status, 401);
    const renewed = await asked(codeFor(one.secret, 1));
    assert.equal(renewed.status, 200, JSON.stringify(renewed.body));
    const fresher = renewed.body.backupCodes as string[];
    assert.equal(fresher.length, 10);
    assert.ok(!fresher.some((code) => one.backupCodes.includes(code)));
    assert.equal((await verify(one.email, one.backupCodes[0])).status, 401, "an old backup code outlived its set");
    assert.equal((await verify(one.email, fresher[0])).status, 200);
    assert.equal((await trail(one.id, "user.mfaCodes")).length, 1);

    const status = await request(http).get("/auth/mfa").set("Authorization", `Bearer ${one.access}`);
    assert.equal(status.status, 200);
    assert.equal(status.body.required, true);
    assert.equal(typeof status.body.enabledAt, "string");
    assert.equal(status.body.backupCodesLeft, 9);
  });

  it("lets an ADMIN reset someone else with a trail line, and nobody themselves", async () => {
    const admin = await enroll("admin", "ADMIN");
    const held = await enroll("held", "HR");
    const asAdmin = (path: string) =>
      request(http).delete(path).set("Authorization", `Bearer ${admin.access}`).set("X-Forwarded-For", fresh());

    const listed = await request(http)
      .get("/users")
      .query({ search: held.email })
      .set("Authorization", `Bearer ${admin.access}`);
    assert.equal(typeof listed.body.rows[0].mfaEnabledAt, "string", "the users page cannot tell who has an app");

    assert.equal((await asAdmin(`/users/${held.id}/mfa`)).status, 204);
    const line = await trail(held.id, "user.mfaReset");
    assert.equal(line.length, 1);
    assert.equal(line[0].actorId, admin.id, "the reset does not say who pressed it");
    assert.equal(await db.session.count({ where: { userId: held.id, revokedAt: null } }), 0, "the reset left a session open");
    assert.equal(await db.userMfa.count({ where: { userId: held.id } }), 0);
    await ticket(held.email, "enroll");

    const twice = await asAdmin(`/users/${held.id}/mfa`);
    assert.equal(twice.status, 409);
    assert.equal(twice.body.message, "MFA_NOT_ON");
    const self = await asAdmin(`/users/${admin.id}/mfa`);
    assert.equal(self.status, 403);
    assert.equal(self.body.message, "SELF_ACCOUNT");
  });

  it("counts the code doors per address", async () => {
    const from = `198.51.102.${Number.parseInt(RUN.slice(0, 2), 16) % 250}`;
    for (let call = 0; call < MFA_BUCKET; call += 1) {
      const res = await post("/auth/mfa/verify", { challenge: "not-a-ticket", code: "123456" }, from);
      assert.equal(res.status, 401, `call ${call + 1}`);
    }
    const over = await post("/auth/mfa/verify", { challenge: "not-a-ticket", code: "123456" }, from);
    assert.equal(over.status, 429);
    assert.equal(over.body.message, "RATE_LIMITED");
  });
});
