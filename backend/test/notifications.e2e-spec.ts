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
import { dayAsDate, localDay } from "../src/modules/timesheet/local-day.js";

const OPEN = "E2ENT01";
const CLOSED = "E2ENT02";
const LOCKED = "E2ENT03";
const LEAVER = "E2ENT04";
const CODES = [OPEN, CLOSED, LOCKED, LEAVER];
const MAIL = (code: string) => `${code.toLowerCase()}@kiosk.local`;
const PASSWORD = "kiosk-e2e-password";
const DAY_MS = 86_400_000;
const ENDPOINT = "https://fcm.googleapis.com/fcm/send/e2e-notifications";
const DEVICE = (code: string, device: string) => `${ENDPOINT}-${code}-${device}`;
const DEVICES = ["phone", "laptop"];

describe("notices and push devices (e2e)", () => {
  let app: INestApplication;
  let db: PrismaService;
  let admin = "";
  let mine = "";
  let openContract = "";
  let closedContract = "";

  async function sweep(): Promise<void> {
    await db.pushSubscription.deleteMany({ where: { endpoint: { startsWith: ENDPOINT } } });
    await db.user.deleteMany({ where: { email: { in: CODES.map(MAIL) } } });
    await db.employee.deleteMany({ where: { code: { in: CODES } } });
  }

  async function devicesOf(code: string): Promise<string[]> {
    const login = await db.user.findUniqueOrThrow({ where: { email: MAIL(code) } });
    for (const device of DEVICES) {
      await db.pushSubscription.upsert({
        where: { endpoint: DEVICE(code, device) },
        update: {},
        create: { userId: login.id, endpoint: DEVICE(code, device), p256dh: "k", auth: "a" },
      });
    }
    return (await db.pushSubscription.findMany({ where: { userId: login.id }, select: { endpoint: true } }))
      .map((one) => one.endpoint)
      .sort();
  }

  function endingIn(days: number): Date {
    const today = dayAsDate(localDay(new Date(), validateEnv().APP_TIMEZONE));
    return new Date(today.getTime() + days * DAY_MS);
  }

  before(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    db = app.get(PrismaService);
    await sweep();

    const hash = await hashPassword(PASSWORD);
    for (const code of [LOCKED, LEAVER]) {
      await db.employee.create({
        data: {
          code,
          fullName: `Người ${code}`,
          active: true,
          login: { create: { email: MAIL(code), passwordHash: hash, role: "EMPLOYEE" } },
        },
      });
    }
    for (const code of [OPEN, CLOSED]) {
      const person = await db.employee.create({
        data: {
          code,
          fullName: `Người ${code}`,
          active: true,
          login: { create: { email: MAIL(code), passwordHash: hash, role: "EMPLOYEE", active: code === OPEN } },
          contracts: {
            create: {
              kind: "FIXED_TERM",
              state: "ACTIVE",
              startDate: endingIn(-300),
              endDate: endingIn(code === OPEN ? 30 : 15),
            },
          },
        },
        include: { contracts: true },
      });
      if (code === OPEN) {
        openContract = person.contracts[0]?.id ?? "";
      } else {
        closedContract = person.contracts[0]?.id ?? "";
      }
    }
    const auth = app.get(AuthService);
    admin = (await auth.signIn("admin@kiosk.local", validateEnv().SEED_ADMIN_PASSWORD ?? "", {})).accessToken;
    mine = (await auth.signIn(MAIL(OPEN), PASSWORD, {})).accessToken;
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("sweeps contracts at a mark without falling over, and tells each mark once", async () => {
    for (let run = 0; run < 2; run += 1) {
      const res = await request(app.getHttpServer())
        .post("/notifications/sweeps/contracts")
        .set("Authorization", `Bearer ${admin}`);
      assert.equal(res.status, 201, JSON.stringify(res.body));
    }
    assert.equal(
      await db.notification.count({ where: { kind: "CONTRACT_ENDING", subjectId: openContract } }),
      1,
      "a contract at its mark was told twice or not at all",
    );
  });

  it("tells nobody through a login that is closed", async () => {
    assert.equal(await db.notification.count({ where: { kind: "CONTRACT_ENDING", subjectId: closedContract } }), 0);
  });

  it("will not drop every device when no endpoint is named", async () => {
    const login = await db.user.findUniqueOrThrow({ where: { email: MAIL(OPEN) } });
    await db.pushSubscription.create({ data: { userId: login.id, endpoint: ENDPOINT, p256dh: "k", auth: "a" } });
    const res = await request(app.getHttpServer())
      .delete("/notifications/subscribe")
      .set("Authorization", `Bearer ${mine}`);
    assert.equal(res.status, 400);
    assert.equal(res.body.message, "PUSH_ENDPOINT_REQUIRED");
    assert.equal(await db.pushSubscription.count({ where: { endpoint: ENDPOINT } }), 1, "a bare delete dropped a device");
  });

  it("keeps a device with the account that registered it", async () => {
    const res = await request(app.getHttpServer())
      .post("/notifications/subscribe")
      .set("Authorization", `Bearer ${admin}`)
      .send({ endpoint: ENDPOINT, p256dh: "k", auth: "a" });
    assert.equal(res.status, 409);
    assert.equal(res.body.message, "PUSH_ENDPOINT_TAKEN");
    const owner = await request(app.getHttpServer())
      .post("/notifications/subscribe")
      .set("Authorization", `Bearer ${mine}`)
      .send({ endpoint: ENDPOINT, p256dh: "k2", auth: "a2" });
    assert.equal(owner.status, 201);
    assert.ok(!("auth" in owner.body), "the answer echoed the device secret");
  });

  it("filters the bell to unread notices when asked", async () => {
    const res = await request(app.getHttpServer())
      .get("/notifications?status=unread")
      .set("Authorization", `Bearer ${mine}`);
    assert.equal(res.status, 200);
    assert.ok((res.body.rows as { readAt: string | null }[]).every((one) => one.readAt === null));
  });

  it("drops the device a person signs out on, and keeps their other one", async () => {
    assert.deepEqual(await devicesOf(LOCKED), DEVICES.map((one) => DEVICE(LOCKED, one)).sort());
    const session = await app.get(AuthService).signIn(MAIL(LOCKED), PASSWORD, {});
    const res = await request(app.getHttpServer())
      .post("/auth/logout")
      .set("Authorization", `Bearer ${session.accessToken}`)
      .send({ pushEndpoint: DEVICE(LOCKED, "phone") });
    assert.equal(res.status, 204, JSON.stringify(res.body));
    const left = await db.pushSubscription.findMany({ where: { endpoint: { startsWith: DEVICE(LOCKED, "") } } });
    assert.deepEqual(left.map((one) => one.endpoint), [DEVICE(LOCKED, "laptop")], "sign-out dropped the wrong devices");
  });

  it("drops every device of an account when it is locked", async () => {
    await devicesOf(LOCKED);
    const login = await db.user.findUniqueOrThrow({ where: { email: MAIL(LOCKED) } });
    const res = await request(app.getHttpServer())
      .patch(`/users/${login.id}`)
      .set("Authorization", `Bearer ${admin}`)
      .send({ active: false });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(await db.pushSubscription.count({ where: { userId: login.id } }), 0, "a locked account still gets pushes");
  });

  it("drops every device of somebody whose record closes", async () => {
    await devicesOf(LEAVER);
    const person = await db.employee.findUniqueOrThrow({ where: { code: LEAVER } });
    const res = await request(app.getHttpServer())
      .post(`/employees/${person.id}/offboard`)
      .set("Authorization", `Bearer ${admin}`)
      .send({ leaveDate: localDay(new Date(), validateEnv().APP_TIMEZONE) });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const login = await db.user.findUniqueOrThrow({ where: { email: MAIL(LEAVER) } });
    assert.equal(login.active, false, "the record closed and left the login open");
    assert.equal(await db.pushSubscription.count({ where: { userId: login.id } }), 0, "somebody who left still gets pushes");
  });
});
