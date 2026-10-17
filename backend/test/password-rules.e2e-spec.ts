import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { AuthService } from "../src/modules/auth/auth.service.js";
import { COMMON_PASSWORDS } from "../src/modules/auth/common-passwords.generated.js";
import { hashPassword } from "../src/modules/auth/password.js";
import { seedEntityId, tokensOf } from "./fixtures.js";

const CODE = "E2EPW01";
const NAME = "Trần Thị Mật Khẩu";
const EMAIL = "e2epw-holder@kiosk.local";
const PASSWORD = "kiosk-e2e-password-rules";
const NEXT = "an-entirely-fresh-phrase-9";
const HOUR_MS = 3_600_000;

// The server keeps only this hash of a one-use link (KEHOACH 9.4).
function hashOf(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

describe("a new password is new, uncommon and impersonal, and its mail can say not me (e2e)", () => {
  let app: INestApplication;
  let db: PrismaService;
  let auth: AuthService;
  let userId = "";
  let token = "";
  const common = COMMON_PASSWORDS.find((one) => /^[a-z0-9]{12,40}$/.test(one)) as string;

  async function sweep(): Promise<void> {
    await db.user.deleteMany({ where: { email: EMAIL } });
    await db.employee.deleteMany({ where: { code: CODE } });
  }

  function change(next: string): request.Test {
    return request(app.getHttpServer())
      .post("/auth/change-password")
      .set("Authorization", `Bearer ${token}`)
      .send({ current: PASSWORD, next });
  }

  async function link(table: "passwordSetup" | "passwordAlarm", expiresAt: Date): Promise<string> {
    const plain = randomBytes(32).toString("base64url");
    const data = { userId, tokenHash: hashOf(plain), expiresAt };
    await (table === "passwordSetup" ? db.passwordSetup.create({ data }) : db.passwordAlarm.create({ data }));
    return plain;
  }

  before(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    db = app.get(PrismaService);
    auth = app.get(AuthService);
    await sweep();
    const person = await db.employee.create({
      data: { code: CODE, fullName: NAME, active: true, legalEntityId: await seedEntityId(db) },
    });
    const user = await db.user.create({
      data: { email: EMAIL, passwordHash: await hashPassword(PASSWORD), role: "EMPLOYEE", employeeId: person.id },
    });
    userId = user.id;
    token = tokensOf(await auth.signIn(EMAIL, PASSWORD, {})).accessToken;
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("refuses the password in hand as the new one", async () => {
    const res = await change(PASSWORD);
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.message, "PASSWORD_UNCHANGED");
  });

  it("refuses a common password at both doors, in any case, and keeps the link it was offered on", async () => {
    assert.ok(common, "the generated list holds no plain password of 12 to 40 characters");
    for (const typed of [common, common.toUpperCase()]) {
      const res = await change(typed);
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.equal(res.body.message, "PASSWORD_COMMON");
    }
    const plain = await link("passwordSetup", new Date(Date.now() + HOUR_MS));
    const res = await request(app.getHttpServer()).post("/auth/set-password").send({ token: plain, password: common });
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(res.body.message, "PASSWORD_COMMON");
    const kept = await db.passwordSetup.findUniqueOrThrow({ where: { tokenHash: hashOf(plain) } });
    assert.equal(kept.usedAt, null, "a refused password spent the link");
  });

  it("refuses a password holding the account's email name, full name or employee code", async () => {
    for (const typed of ["Tran Thi Mat Khau 2026", `door-${CODE.toLowerCase()}-garden`, "E2Epw.Holder.4242!"]) {
      const res = await change(typed);
      assert.equal(res.status, 400, `${typed}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.message, "PASSWORD_PERSONAL", typed);
    }
  });

  it("takes a good password, closes every session and leaves a not-me link behind", async () => {
    const res = await change(NEXT);
    assert.equal(res.status, 204, JSON.stringify(res.body));
    assert.equal(await db.session.count({ where: { userId, revokedAt: null } }), 0);
    const alarm = await db.passwordAlarm.findFirst({ where: { userId, usedAt: null } });
    assert.ok(alarm, "the password-changed mail carries no not-me link");
    assert.ok(alarm.expiresAt.getTime() > Date.now() + HOUR_MS, "the not-me link dies within the hour");
  });

  it("answers not me once: every session closed, the other links spent, a reset link on its way", async () => {
    await auth.signIn(EMAIL, NEXT, {});
    assert.ok((await db.session.count({ where: { userId, revokedAt: null } })) > 0);
    const plain = await link("passwordAlarm", new Date(Date.now() + HOUR_MS));
    const pressed = new Date();
    const res = await request(app.getHttpServer()).post("/auth/not-me").send({ token: plain });
    assert.equal(res.status, 204, JSON.stringify(res.body));
    assert.equal(await db.session.count({ where: { userId, revokedAt: null } }), 0, "a session outlived not me");
    assert.equal(await db.passwordAlarm.count({ where: { userId, usedAt: null } }), 0, "another not-me link stayed live");
    const sent = await db.passwordSetup.findMany({ where: { userId, usedAt: null, expiresAt: { gt: new Date() } } });
    assert.equal(sent.length, 1, "not me left other than one live reset link");
    assert.ok((sent[0] as { createdAt: Date }).createdAt >= new Date(pressed.getTime() - 1000));

    const again = await request(app.getHttpServer()).post("/auth/not-me").send({ token: plain });
    assert.equal(again.status, 401);
    assert.equal(again.body.message, "ALARM_SPENT");
  });

  it("refuses a not-me link past its hours", async () => {
    const plain = await link("passwordAlarm", new Date(Date.now() - 1000));
    const res = await request(app.getHttpServer()).post("/auth/not-me").send({ token: plain });
    assert.equal(res.status, 401);
    assert.equal(res.body.message, "ALARM_SPENT");
  });
});
