import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { REFRESH_COOKIE } from "../src/modules/auth/auth.types.js";
import { hashPassword } from "../src/modules/auth/password.js";

const CODE = "E2EAU01";
const ACCOUNT = "e2eaudit@kiosk.local";
const CARRIER = "e2eaudit-carrier@kiosk.local";
const CARRIER_PASSWORD = "kiosk-e2e-password";
const FIRST_PAY = 11_000_000;
const NEXT_PAY = 13_500_000;

interface Row {
  action: string;
  subjectType: string;
  subjectId: string;
  actorId: string | null;
  meta: Record<string, unknown> | null;
}

describe("audit trail (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let token = "";
  let refreshCookie = "";
  let employeeId = 0;
  let accountId = "";

  async function sweep(): Promise<void> {
    await db.user.deleteMany({ where: { email: { in: [ACCOUNT, CARRIER] } } });
    await db.employee.deleteMany({ where: { code: CODE } });
  }

  async function trail(query: string): Promise<Row[]> {
    const res = await request(http)
      .get(`/audit?${query}`)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    return res.body.rows as Row[];
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

    // Its own identity: every suite signs in as the seed admin, and the tenth
    // of those logins evicts whichever session has sat idle longest.
    await db.user.create({
      data: {
        email: CARRIER,
        passwordHash: await hashPassword(CARRIER_PASSWORD),
        role: "VIEWER",
      },
    });
    const carrier = await request(http)
      .post("/auth/login")
      .send({ email: CARRIER, password: CARRIER_PASSWORD });
    assert.equal(carrier.status, 200);
    const jar = (carrier.headers["set-cookie"] ?? []) as unknown as string[];
    refreshCookie = (jar.find((line) => line.startsWith(`${REFRESH_COOKIE}=`)) ?? "").split(";")[0];

    const made = await request(http)
      .post("/employees")
      .set("Authorization", `Bearer ${token}`)
      .send({ code: CODE, fullName: "Người bị soi" });
    assert.equal(made.status, 201);
    employeeId = made.body.id;

    const account = await request(http)
      .post("/users")
      .set("Authorization", `Bearer ${token}`)
      .send({ email: ACCOUNT, role: "VIEWER" });
    assert.equal(account.status, 201);
    accountId = account.body.id;
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("files a new employee under the employee, by id", async () => {
    const rows = await trail(`subjectType=employee&subjectId=${employeeId}`);
    const made = rows.find((row) => row.action === "employee.create");
    assert.ok(made, "creating a person left nothing under that person");
    assert.ok(made.actorId, "the entry does not say who did it");
  });

  it("says what a pay change went from and to", async () => {
    const first = await request(http)
      .post("/compensation")
      .set("Authorization", `Bearer ${token}`)
      .send({
        employeeId,
        effectiveFrom: "2026-01-01",
        baseSalary: FIRST_PAY,
        insuranceSalary: FIRST_PAY,
        reason: "HIRE",
      });
    assert.equal(first.status, 201);
    const raise = await request(http)
      .post("/compensation")
      .set("Authorization", `Bearer ${token}`)
      .send({
        employeeId,
        effectiveFrom: "2026-07-01",
        baseSalary: NEXT_PAY,
        insuranceSalary: NEXT_PAY,
        reason: "ANNUAL_REVIEW",
      });
    assert.equal(raise.status, 201);

    const rows = await trail(`subjectType=employee&subjectId=${employeeId}&action=pay.create`);
    assert.equal(rows.length, 2);
    assert.deepEqual(
      [rows[0].meta?.from, rows[0].meta?.to],
      [String(FIRST_PAY), String(NEXT_PAY)],
      "a raise that does not say what it left behind is half an answer",
    );
    assert.equal(rows[1].meta?.from, null, "the first record has nothing before it");
  });

  it("says what a role change went from and to", async () => {
    const moved = await request(http)
      .patch(`/users/${accountId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ role: "HR" });
    assert.equal(moved.status, 200);

    const rows = await trail(`subjectType=user&subjectId=${accountId}&action=user.role`);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].meta?.from, rows[0].meta?.to], ["VIEWER", "HR"]);
  });

  it("names the fields a profile edit touched and none of their values", async () => {
    const edited = await request(http)
      .patch(`/employees/${employeeId}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ fullName: "Người đã đổi tên", phone: "0900000000" });
    assert.equal(edited.status, 200);

    const rows = await trail(`subjectType=employee&subjectId=${employeeId}&action=employee.update`);
    assert.equal(rows.length, 1);
    assert.deepEqual(rows[0].meta?.fields, ["fullName", "phone"]);
    const written = JSON.stringify(rows[0].meta);
    assert.ok(!written.includes("0900000000"), "the trail kept a second copy of personal data");
    assert.ok(!written.includes("đã đổi tên"), "the trail kept a second copy of personal data");
  });

  it("leaves nothing behind when a session merely carries on", async () => {
    const where = { subjectType: "route", subjectId: "/auth/refresh" };
    const before = await db.auditLog.count({ where });
    const carried = await request(http).post("/auth/refresh").set("Cookie", refreshCookie);
    assert.equal(carried.status, 200);
    assert.equal(await db.auditLog.count({ where }), before, "a token refresh wrote a row");
  });

  it("holds one story per person, whatever kind of change it was", async () => {
    const rows = await trail(`subjectType=employee&subjectId=${employeeId}`);
    const kinds = new Set(rows.map((row) => row.action));
    assert.ok(kinds.has("employee.create"));
    assert.ok(kinds.has("employee.update"));
    assert.ok(kinds.has("pay.create"));
    assert.ok(
      rows.every((row) => row.subjectId === String(employeeId)),
      "one subject type is using two kinds of identifier",
    );
  });
});
