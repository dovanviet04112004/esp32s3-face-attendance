import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { AuthService } from "../src/modules/auth/auth.service.js";
import { hashPassword } from "../src/modules/auth/password.js";
import { NotificationsService } from "../src/modules/notifications/notifications.service.js";

const BOTH_ON = "E2ENC01";
const IN_APP_OFF = "E2ENC02";
const PUSH_OFF = "E2ENC03";
const CODES = [BOTH_ON, IN_APP_OFF, PUSH_OFF];
const KIND = "PAYSLIP_ISSUED";
const OTHER_KIND = "CONTRACT_ENDING";
const MAIL = "e2enc@kiosk.local";
const PASSWORD = "kiosk-e2e-password";

describe("notice channels answer for themselves (e2e)", () => {
  let app: INestApplication;
  let db: PrismaService;
  let notices: NotificationsService;
  const idOf = new Map<string, number>();
  let mine = "";

  async function sweep(): Promise<void> {
    await db.user.deleteMany({ where: { email: MAIL } });
    await db.employee.deleteMany({ where: { code: { in: CODES } } });
  }

  async function heldFor(code: string): Promise<number> {
    return db.notification.count({ where: { employeeId: idOf.get(code), kind: KIND } });
  }

  before(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    db = app.get(PrismaService);
    notices = app.get(NotificationsService);
    await sweep();

    for (const code of CODES) {
      const made = await db.employee.create({
        data: { code, fullName: `Kênh ${code}`, active: true },
      });
      idOf.set(code, made.id);
    }
    await db.notificationPreference.create({
      data: { employeeId: idOf.get(IN_APP_OFF) as number, kind: KIND, channel: "IN_APP", on: false },
    });
    await db.notificationPreference.create({
      data: { employeeId: idOf.get(PUSH_OFF) as number, kind: KIND, channel: "PUSH", on: false },
    });
    await db.user.create({
      data: {
        email: MAIL,
        passwordHash: await hashPassword(PASSWORD),
        role: "EMPLOYEE",
        employeeId: idOf.get(BOTH_ON) as number,
      },
    });
    mine = (await app.get(AuthService).signIn(MAIL, PASSWORD, {})).accessToken;
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("lets somebody with a record switch a channel that has a delivery", async () => {
    const res = await request(app.getHttpServer())
      .post("/notifications/preferences")
      .set("Authorization", `Bearer ${mine}`)
      .send({ kind: OTHER_KIND, channel: "PUSH", on: false });
    assert.equal(res.status, 201, "an employee could not turn their own push off");
  });

  it("refuses a channel nobody delivers", async () => {
    const res = await request(app.getHttpServer())
      .post("/notifications/preferences")
      .set("Authorization", `Bearer ${mine}`)
      .send({ kind: OTHER_KIND, channel: "EMAIL", on: true });
    assert.equal(res.status, 400, "a switch with no delivery behind it was accepted");
  });

  it("offers only the channels somebody delivers", async () => {
    const res = await request(app.getHttpServer())
      .get("/notifications/preferences")
      .set("Authorization", `Bearer ${mine}`);
    assert.equal(res.status, 200);
    const rows = res.body as { channel: string }[];
    assert.deepEqual([...new Set(rows.map((row) => row.channel))].sort(), ["IN_APP", "PUSH"]);
  });

  it("refuses to file a switch for an account with no record to hang it on", async () => {
    const admin = (
      await app.get(AuthService).signIn("admin@kiosk.local", validateEnv().SEED_ADMIN_PASSWORD ?? "", {})
    ).accessToken;
    const res = await request(app.getHttpServer())
      .post("/notifications/preferences")
      .set("Authorization", `Bearer ${admin}`)
      .send({ kind: OTHER_KIND, channel: "PUSH", on: false });
    assert.equal(res.status, 403, "a login with no employee row reached the foreign key");
  });

  it("writes an in-app notice for a whole payroll period at once", async () => {
    await notices.raiseMany([...idOf.values()], KIND, {});
    assert.equal(await heldFor(BOTH_ON), 1, "somebody with both channels on was told nothing");
  });

  it("writes none for somebody who turned the in-app channel off", async () => {
    assert.equal(await heldFor(IN_APP_OFF), 0, "a channel somebody turned off still wrote a row");
  });

  it("does not let the push switch speak for the in-app one", async () => {
    assert.equal(await heldFor(PUSH_OFF), 1, "turning push off silenced the in-app notice too");
  });

  it("asks one switch per channel, so neither reads the other's answer", async () => {
    const asked = await db.notificationPreference.findMany({
      where: { employeeId: idOf.get(PUSH_OFF), kind: KIND },
      select: { channel: true, on: true },
    });
    const push = asked.find((row) => row.channel === "PUSH");
    assert.equal(push?.on, false, "the fixture lost the switch this suite turns on its head");
    assert.equal(
      asked.some((row) => row.channel === "IN_APP"),
      false,
      "an in-app switch nobody set would make the claim above vacuous",
    );
  });
});
