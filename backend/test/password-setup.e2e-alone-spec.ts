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
import { AuthService } from "../src/modules/auth/auth.service.js";
import { UNUSABLE_PASSWORD, verifyPassword } from "../src/modules/auth/password.js";
import { QUEUE_TOKEN, type Queues } from "../src/queue/queue.module.js";
import { QUEUE, type PasswordSetupJob } from "../src/queue/queues.js";

const CODE = "E2EPS01";
const EMAIL = "e2eps@kiosk.local";
const CHOSEN = "a-password-they-picked";
const NEXT_ONE = "the-one-after-forgetting";
const CHANGED = "the-one-they-changed-to";

describe("first password (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let queues: Queues;
  let token = "";
  let userId = "";
  let link = "";
  let auth: AuthService;

  async function sweep(): Promise<void> {
    await db.user.deleteMany({ where: { email: EMAIL } });
    await db.employee.deleteMany({ where: { code: CODE } });
  }

  async function signIn(password: string): Promise<request.Response> {
    return request(http).post("/auth/login").send({ email: EMAIL, password });
  }

  async function live(): Promise<number> {
    return db.session.count({ where: { userId, revokedAt: null } });
  }

  /** Asks the hash rather than the login door, which has an allowance. */
  async function opensWith(password: string): Promise<boolean> {
    const held = await db.user.findUniqueOrThrow({ where: { id: userId } });
    return verifyPassword(password, held.passwordHash);
  }

  before(async () => {
    const env = validateEnv();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    http = app.getHttpServer();
    db = app.get(PrismaService);
    auth = app.get(AuthService);
    queues = app.get(QUEUE_TOKEN);
    await sweep();

    const signedIn = await request(http)
      .post("/auth/login")
      .send({ email: "admin@kiosk.local", password: env.SEED_ADMIN_PASSWORD ?? "" });
    assert.equal(signedIn.status, 200, "admin could not sign in");
    token = signedIn.body.accessToken;

    await db.employee.create({
      data: { code: CODE, fullName: "Người mới vào", active: true, personalEmail: EMAIL },
    });
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("opens an account and hands the admin no secret at all", async () => {
    const res = await request(http)
      .post("/users/provision")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 201);
    const done = res.body as { accounts: Record<string, unknown>[]; waiting: number };
    const mine = done.accounts.find((one) => one.employeeCode === CODE);
    assert.ok(mine, "provisioning skipped the person under test");
    assert.deepEqual(
      Object.keys(mine).sort(),
      ["email", "employeeCode", "role"],
      "the answer carries something the admin was not meant to hold",
    );

    const account = await db.user.findUniqueOrThrow({ where: { email: EMAIL } });
    userId = account.id;
    assert.equal(account.role, "EMPLOYEE");
  });

  it("leaves that account unable to sign in", async () => {
    for (const guess of [CHOSEN, "the-obvious-guess", "another-long-guess"]) {
      assert.equal((await signIn(guess)).status, 401, `"${guess}" opened an unset account`);
    }
  });

  // Not through the login route: its body validator refuses anything under
  // eight characters, so the sentinel never reaches the check being tested.
  it("stores a hash no password can match, not an empty one", async () => {
    const account = await db.user.findUniqueOrThrow({ where: { email: EMAIL } });
    assert.equal(account.passwordHash, UNUSABLE_PASSWORD);
    assert.ok(account.passwordHash.length > 0, "an empty hash would be a null branch in disguise");
    for (const guess of [UNUSABLE_PASSWORD, "", CHOSEN, "none"]) {
      assert.equal(await verifyPassword(guess, account.passwordHash), false, `"${guess}" matched`);
    }
  });

  // The mailer reads the link off this job, so this is where a test sees it.
  it("queues one invitation carrying the link the server does not keep", async () => {
    const jobs = await queues[QUEUE.notify].getJobs(["waiting", "delayed", "completed", "active"]);
    const mine = jobs
      .map((job) => job.data as PasswordSetupJob)
      .find((data) => data.type === "password-setup" && data.userId === userId);
    assert.ok(mine, "nobody was asked to send the invitation");
    assert.equal(mine.reason, "opened", "a first invitation went out worded as a recovery");
    link = new URL(mine.link).searchParams.get("token") ?? "";
    assert.ok(link, "the invitation carries no link");

    const held = await db.passwordSetup.findFirstOrThrow({ where: { userId } });
    assert.notEqual(held.tokenHash, link, "the server stored the link itself");
    assert.equal(held.usedAt, null);
  });

  it("refuses a link nobody issued", async () => {
    const res = await request(http)
      .post("/auth/set-password")
      .send({ token: "not-a-link-anybody-sent", password: CHOSEN });
    assert.equal(res.status, 401);
    assert.equal(res.body.message, "SETUP_LINK_SPENT");
  });

  it("lets them set their own password and sign in with it", async () => {
    const set = await request(http)
      .post("/auth/set-password")
      .send({ token: link, password: CHOSEN });
    assert.equal(set.status, 204);

    const res = await signIn(CHOSEN);
    assert.equal(res.status, 200, "the password they set does not open the account");
    assert.equal(typeof res.body.accessToken, "string");
  });

  it("closes the link once it is spent", async () => {
    const again = await request(http)
      .post("/auth/set-password")
      .send({ token: link, password: "a-different-password" });
    assert.equal(again.status, 401);
    assert.equal(again.body.message, "SETUP_LINK_SPENT");
    assert.equal((await signIn(CHOSEN)).status, 200, "a refused second use changed the password");
  });

  it("answers a forgotten password the same whether the address exists or not", async () => {
    const known = await request(http).post("/auth/forgot-password").send({ email: EMAIL });
    const unknown = await request(http)
      .post("/auth/forgot-password")
      .send({ email: "nobody-e2eps@kiosk.local" });
    assert.equal(known.status, 204);
    assert.equal(
      unknown.status,
      known.status,
      "the door answers differently for an address with an account",
    );
    assert.deepEqual(unknown.body, known.body, "the two answers differ in their body");

    const minted = await db.passwordSetup.count({ where: { userId } });
    assert.ok(minted >= 1, "asking for a link minted none");

    // The link is the same one; the letter around it is not (KEHOACH 9.4).
    const queued = await queues[QUEUE.notify].getJobs([
      "waiting",
      "delayed",
      "completed",
      "active",
    ]);
    const asked = queued
      .map((job) => job.data as PasswordSetupJob)
      .filter((data) => data.type === "password-setup" && data.userId === userId)
      .some((data) => data.reason === "forgot");
    assert.ok(asked, "a forgotten password was mailed the welcome letter");
    assert.equal(
      await db.user.count({ where: { email: "nobody-e2eps@kiosk.local" } }),
      0,
      "an address nobody owns left a row behind",
    );
  });

  it("lets a forgotten password be set again through the link it mailed", async () => {
    const fresh = randomBytes(32).toString("base64url");
    await db.passwordSetup.create({
      data: {
        userId,
        tokenHash: createHash("sha256").update(fresh).digest("hex"),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
    const set = await request(http)
      .post("/auth/set-password")
      .send({ token: fresh, password: NEXT_ONE });
    assert.equal(set.status, 204);
    assert.ok(await opensWith(NEXT_ONE), "the password set through the new link does not open it");
  });

  it("changes a password only for somebody who holds the current one", async () => {
    // Signing in goes through the service: the login door is counted by the
    // minute and this suite would spend the whole allowance on setup.
    const access = (await auth.signIn(EMAIL, NEXT_ONE, {})).accessToken;

    const wrong = await request(http)
      .post("/auth/change-password")
      .set("Authorization", `Bearer ${access}`)
      .send({ current: "not-the-password", next: "another-long-password" });
    assert.equal(wrong.status, 401, "a session alone was enough to replace the password");
    assert.ok(await opensWith(NEXT_ONE), "a refused change moved the password anyway");

    const right = await request(http)
      .post("/auth/change-password")
      .set("Authorization", `Bearer ${access}`)
      .send({ current: NEXT_ONE, next: CHANGED });
    assert.equal(right.status, 204);
    assert.ok(await opensWith(CHANGED), "the password it was changed to does not open it");
    assert.ok(!(await opensWith(NEXT_ONE)), "the old password still opens the account");
  });

  it("closes every device when a password changes under it", async () => {
    const access = (await auth.signIn(EMAIL, CHANGED, {})).accessToken;
    await auth.signIn(EMAIL, CHANGED, {});
    assert.ok((await live()) >= 2, "the account does not hold the devices this needs");

    const done = await request(http)
      .post("/auth/change-password")
      .set("Authorization", `Bearer ${access}`)
      .send({ current: CHANGED, next: CHOSEN });
    assert.equal(done.status, 204);
    assert.equal(await live(), 0, "a password nobody else knows left a device signed in");
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
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 201);
    const done = res.body as { accounts: { email: string }[]; waiting: number };
    assert.equal(done.accounts.length, batch, "one call opened more logins than the batch allows");
    assert.ok(done.waiting >= 3, "the answer does not say how many people are still waiting");

    await db.user.deleteMany({ where: { email: { startsWith: "e2epv-" } } });
    await db.employee.deleteMany({ where: { code: { in: codes } } });
  });

  it("refuses a link whose hours have run out", async () => {
    await db.passwordSetup.updateMany({
      where: { userId },
      data: { usedAt: null, expiresAt: new Date(Date.now() - 1000) },
    });
    const res = await request(http)
      .post("/auth/set-password")
      .send({ token: link, password: "another-password-again" });
    assert.equal(res.status, 401);
    assert.equal(res.body.message, "SETUP_LINK_SPENT");
  });
});
