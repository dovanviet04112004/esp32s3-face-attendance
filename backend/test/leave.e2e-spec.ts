import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";

const CODE = "NV9301";
const EMAIL = "nv9301@kiosk.local";
const ENTITLED = 12;

// Far enough ahead that nothing the seed filed can overlap it.
const BOOKED_FROM = "2026-11-10";
const BOOKED_TO = "2026-11-12";
const BOOKED_DAYS = 3;
const BEFORE_IT = "2026-11-01";
const AFTER_IT = "2026-11-20";

interface Balance {
  leaveTypeId: string;
  code: string;
  year: number;
  entitled: number;
  remaining: number;
  bookedAfter: number;
}

describe("leave balance (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let token = "";
  let leaveTypeId = "";
  const opened: string[] = [];

  async function sweep(): Promise<void> {
    await db.user.deleteMany({ where: { email: { in: [EMAIL, ...opened] } } });
    await db.employee.deleteMany({ where: { code: CODE } });
  }

  async function balancesAt(asOf: string): Promise<Balance[]> {
    const res = await request(http)
      .get(`/leave-balances?asOf=${asOf}`)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    return res.body as Balance[];
  }

  function annual(rows: Balance[]): Balance {
    const row = rows.find((one) => one.leaveTypeId === leaveTypeId);
    assert.ok(row, "the annual leave row is missing");
    return row;
  }

  async function fileLeave(from: string, to: string): Promise<request.Response> {
    return request(http)
      .post("/requests")
      .set("Authorization", `Bearer ${token}`)
      .send({ kind: "LEAVE", leaveTypeId, fromDate: from, toDate: to, reason: "e2e" });
  }

  before(async () => {
    const env = validateEnv();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    http = app.getHttpServer();
    db = app.get(PrismaService);
    await sweep();

    const asAdmin = await request(http)
      .post("/auth/login")
      .send({ email: "admin@kiosk.local", password: env.SEED_ADMIN_PASSWORD ?? "" });
    assert.equal(asAdmin.status, 200, "admin could not sign in");

    const type = await db.leaveType.findFirstOrThrow({ where: { active: true, paid: true } });
    leaveTypeId = type.id;

    const template = await db.employee.findFirstOrThrow({ where: { active: true } });
    const made = await db.employee.create({
      data: {
        code: CODE,
        fullName: "Thử số dư phép",
        active: true,
        personalEmail: EMAIL,
        departmentId: template.departmentId,
        legalEntityId: template.legalEntityId,
      },
    });
    await db.leaveBalance.create({
      data: { employeeId: made.id, leaveTypeId, year: 2026, entitled: ENTITLED },
    });

    const provisioned = await request(http)
      .post("/users/provision")
      .set("Authorization", `Bearer ${asAdmin.body.accessToken}`);
    assert.equal(provisioned.status, 201, "could not open employee logins");
    const accounts = provisioned.body as { employeeCode: string; email: string; password: string }[];
    opened.push(...accounts.map((one) => one.email));
    const mine = accounts.find((one) => one.employeeCode === CODE);
    assert.ok(mine, "provisioning skipped the person under test");

    const asMe = await request(http)
      .post("/auth/login")
      .send({ email: EMAIL, password: mine.password });
    assert.equal(asMe.status, 200, "the employee account could not sign in");
    token = asMe.body.accessToken;
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("starts with the whole entitlement free", async () => {
    const row = annual(await balancesAt(BEFORE_IT));
    assert.equal(row.entitled, ENTITLED);
    assert.equal(row.remaining, ENTITLED);
    assert.equal(row.bookedAfter, 0);
  });

  it("takes the days out the moment a request is filed, before anyone answers", async () => {
    assert.equal((await fileLeave(BOOKED_FROM, BOOKED_TO)).status, 201);
    const row = annual(await balancesAt(BEFORE_IT));
    assert.equal(row.remaining, ENTITLED - BOOKED_DAYS);
  });

  it("says how much of what is left is already spoken for after the chosen day", async () => {
    assert.equal(annual(await balancesAt(BEFORE_IT)).bookedAfter, BOOKED_DAYS);
    assert.equal(annual(await balancesAt(AFTER_IT)).bookedAfter, 0);
  });

  it("answers for the year the chosen day falls in, not for today", async () => {
    const next = await balancesAt("2027-03-01");
    assert.equal(next.length, 0, "a year with no entitlement row has no balance to show");
  });

  it("refuses a request the figure it shows says there is no room for", async () => {
    const left = annual(await balancesAt(BEFORE_IT)).remaining;
    const from = new Date(Date.UTC(2026, 11, 1));
    const to = new Date(from.getTime() + left * 86_400_000);
    const res = await fileLeave(from.toISOString().slice(0, 10), to.toISOString().slice(0, 10));
    assert.equal(res.status, 409);
    assert.equal(res.body.message, "LEAVE_BALANCE_SHORT");
  });
});
