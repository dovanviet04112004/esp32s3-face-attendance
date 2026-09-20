import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { hashPassword } from "../src/modules/auth/password.js";

const LEAVER = "E2EOB01";
const EMAIL = "e2eob@kiosk.local";
const PASSWORD = "kiosk-e2e-password";
const ASSET = "E2EOB-AS1";
const YEAR = 2039;
const MONTH = 6;

interface Report {
  code: string;
  assetsOutstanding: { code: string }[];
  requestsPending: number;
}

describe("offboarding (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let token = "";
  let employeeId = 0;
  let refreshCookie = "";
  let periodId = "";
  // Taken from the period this suite checks, so the leaving date cannot
  // drift out of the window that makes the checklist count it.
  let lastDay = "";

  async function sweep(): Promise<void> {
    await db.asset.deleteMany({ where: { code: ASSET } });
    await db.user.deleteMany({ where: { email: EMAIL } });
    await db.employee.deleteMany({ where: { code: LEAVER } });
    await db.payrollPeriod.deleteMany({ where: { year: YEAR } });
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

    const signedIn = await request(http)
      .post("/auth/login")
      .send({ email: "admin@kiosk.local", password: env.SEED_ADMIN_PASSWORD ?? "" });
    assert.equal(signedIn.status, 200, "admin could not sign in");
    token = signedIn.body.accessToken;

    const template = await db.employee.findFirstOrThrow({
      where: { active: true, legalEntityId: { not: null } },
    });
    const made = await db.employee.create({
      data: {
        code: LEAVER,
        fullName: "Sắp nghỉ việc",
        active: true,
        legalEntityId: template.legalEntityId,
        hireDate: new Date("2024-01-01T00:00:00.000Z"),
      },
    });
    employeeId = made.id;
    await db.user.create({
      data: {
        email: EMAIL,
        passwordHash: await hashPassword(PASSWORD),
        role: "EMPLOYEE",
        employeeId,
      },
    });
    // Its own period, not whichever one is newest: another suite adding a
    // later one would move this assertion onto somebody else's entity.
    const period = await db.payrollPeriod.create({
      data: {
        year: YEAR,
        month: MONTH,
        startDate: new Date(Date.UTC(YEAR, MONTH - 1, 1)),
        endDate: new Date(Date.UTC(YEAR, MONTH, 0)),
      },
    });
    periodId = period.id;
    lastDay = period.startDate.toISOString().slice(0, 10);

    const asset = await db.asset.create({
      data: { code: ASSET, name: "Máy chưa thu", kind: "LAPTOP" },
    });
    await request(http)
      .post(`/assets/${asset.id}/hand-over`)
      .set("Authorization", `Bearer ${token}`)
      .send({ employeeId, issued: true });
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("lets the account in while it is open, and keeps a session", async () => {
    const res = await request(http).post("/auth/login").send({ email: EMAIL, password: PASSWORD });
    assert.equal(res.status, 200);
    refreshCookie = (res.headers["set-cookie"] as unknown as string[])[0] as string;
    assert.ok(refreshCookie, "the login handed back a refresh cookie");
  });

  it("closes the record and hands back what is still out", async () => {
    const res = await request(http)
      .post(`/employees/${employeeId}/offboard`)
      .set("Authorization", `Bearer ${token}`)
      .send({ leaveDate: lastDay, reason: "e2e" });
    assert.equal(res.status, 201);
    const report = res.body as Report;
    assert.equal(report.code, LEAVER);
    assert.deepEqual(
      report.assetsOutstanding.map((one) => one.code),
      [ASSET],
      "the laptop they still hold has to come back in the answer",
    );

    const person = await db.employee.findUnique({ where: { id: employeeId } });
    assert.equal(person?.active, false);
    assert.equal(person?.leaveDate?.toISOString().slice(0, 10), lastDay);
  });

  it("shuts the login the same moment, both ways in", async () => {
    const again = await request(http).post("/auth/login").send({ email: EMAIL, password: PASSWORD });
    assert.equal(again.status, 401, "a closed account still signed in");

    const renewed = await request(http).post("/auth/refresh").set("Cookie", refreshCookie);
    assert.equal(renewed.status, 401, "a session opened before leaving outlived the leaving");
  });

  it("puts the unreturned asset in front of whoever locks the period", async () => {
    const res = await request(http)
      .get(`/payroll-periods/${periodId}/checklist`)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    const item = (res.body as { code: string; count: number }[]).find(
      (one) => one.code === "LEAVERS_HOLDING_ASSETS",
    );
    assert.ok(item, "the checklist never mentions unreturned assets");
    assert.ok(item.count >= 1, "the leaver holding a laptop is not counted");
  });
});
