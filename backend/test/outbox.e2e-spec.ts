import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { hashPassword } from "../src/modules/auth/password.js";

const PASSWORD = "kiosk-e2e-password";
const SENDER = "NV9121O";
const NEIGHBOUR = "NV9122O";
const SENDER_EMAIL = "nv9121o@kiosk.local";
const NEIGHBOUR_EMAIL = "nv9122o@kiosk.local";
const ENTITLED = 12;
const LEAVE_DAYS = 2;

// Far enough out that nothing the seed filed can overlap it.
const FROM = "2028-04-10";
const TO = "2028-04-11";
const OT_DAY = "2028-04-20";
const OT_MINUTES = 90;

describe("filed offline (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let token = "";
  let neighbourToken = "";
  let senderId = 0;
  let leaveTypeId = "";

  async function sweep(): Promise<void> {
    await db.user.deleteMany({ where: { email: { in: [SENDER_EMAIL, NEIGHBOUR_EMAIL] } } });
    await db.employee.deleteMany({ where: { code: { in: [SENDER, NEIGHBOUR] } } });
  }

  function file(body: Record<string, unknown>, who = token): Promise<request.Response> {
    return request(http).post("/requests").set("Authorization", `Bearer ${who}`).send(body);
  }

  function overtime(clientKey: string): Record<string, unknown> {
    return {
      clientKey,
      kind: "OVERTIME",
      fromDate: OT_DAY,
      toDate: OT_DAY,
      minutes: OT_MINUTES,
      reason: "e2e outbox",
    };
  }

  before(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    http = app.getHttpServer();
    db = app.get(PrismaService);
    await sweep();

    const template = await db.employee.findFirstOrThrow({ where: { active: true } });
    const annual = await db.leaveType.findFirstOrThrow({ where: { paid: true } });
    leaveTypeId = annual.id;

    for (const [code, email] of [
      [SENDER, SENDER_EMAIL],
      [NEIGHBOUR, NEIGHBOUR_EMAIL],
    ] as const) {
      const made = await db.employee.create({
        data: {
          code,
          fullName: `Thử hàng đợi ${code}`,
          departmentId: template.departmentId,
          legalEntityId: template.legalEntityId,
        },
      });
      if (code === SENDER) {
        senderId = made.id;
      }
      await db.leaveBalance.create({
        data: {
          employeeId: made.id,
          leaveTypeId,
          year: Number(FROM.slice(0, 4)),
          entitled: ENTITLED,
        },
      });
      await db.user.create({
        data: {
          email,
          passwordHash: await hashPassword(PASSWORD),
          role: "EMPLOYEE",
          employeeId: made.id,
        },
      });
      const signedIn = await request(http).post("/auth/login").send({ email, password: PASSWORD });
      assert.equal(signedIn.status, 200, `${code} could not sign in`);
      if (code === SENDER) {
        token = signedIn.body.accessToken;
      } else {
        neighbourToken = signedIn.body.accessToken;
      }
    }
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("files an overtime request the first time", async () => {
    const res = await file(overtime("e2e-outbox-ot-1"));
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.minutes, OT_MINUTES);
  });

  it("returns the same request when the same key arrives again", async () => {
    const again = await file(overtime("e2e-outbox-ot-1"));
    assert.equal(again.status, 201, "a redelivery was refused instead of answered");
    const rows = await db.request.findMany({
      where: { employeeId: senderId, kind: "OVERTIME" },
    });
    assert.equal(rows.length, 1, "a redelivery filed a second overtime request");
    assert.equal(again.body.id, rows[0].id);
  });

  it("files a second request when the key is a different one", async () => {
    const other = await file(overtime("e2e-outbox-ot-2"));
    assert.equal(other.status, 201);
    const rows = await db.request.count({ where: { employeeId: senderId, kind: "OVERTIME" } });
    assert.equal(rows, 2);
  });

  it("holds leave days once, however often the filing arrives", async () => {
    const body = {
      clientKey: "e2e-outbox-leave-1",
      kind: "LEAVE",
      leaveTypeId,
      fromDate: FROM,
      toDate: TO,
      reason: "e2e outbox",
    };
    assert.equal((await file(body)).status, 201);
    assert.equal((await file(body)).status, 201);
    assert.equal((await file(body)).status, 201);

    const balance = await db.leaveBalance.findFirstOrThrow({
      where: { employeeId: senderId, leaveTypeId, year: Number(FROM.slice(0, 4)) },
    });
    assert.equal(
      Number(balance.pending),
      LEAVE_DAYS,
      "three deliveries of one request reserved the days more than once",
    );
    const rows = await db.request.count({ where: { employeeId: senderId, kind: "LEAVE" } });
    assert.equal(rows, 1);
  });

  it("refuses somebody else's key rather than handing back their request", async () => {
    const res = await file(overtime("e2e-outbox-ot-1"), neighbourToken);
    assert.equal(res.status, 403);
    assert.match(JSON.stringify(res.body), /CLIENT_KEY_NOT_YOURS/);
  });

  it("still files without a key at all", async () => {
    const res = await file({
      kind: "OVERTIME",
      fromDate: OT_DAY,
      toDate: OT_DAY,
      minutes: OT_MINUTES,
      reason: "e2e no key",
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.clientKey, null);
  });
});
