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

const BOSS = "E2ESC01";
const MINE = "E2ESC02";
const STRANGER = "E2ESC03";
const MADE_CODES = [BOSS, MINE, STRANGER];

const BOSS_EMAIL = "e2esc-boss@kiosk.local";
const MINE_EMAIL = "e2esc-mine@kiosk.local";
const PASSWORD = "kiosk-e2e-password";
const MADE_EMAILS = [BOSS_EMAIL, MINE_EMAIL];

const MONTH = { from: "2026-09-01", to: "2026-09-19" };
// A pay period no other suite touches, so its sweep removes only this suite's payslip.
const PAY_YEAR = 1999;

describe("row scope (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  const token: Record<string, string> = {};
  const idOf = new Map<string, number>();

  async function sweep(): Promise<void> {
    await db.payrollPeriod.deleteMany({ where: { year: PAY_YEAR } });
    await db.user.deleteMany({ where: { email: { in: MADE_EMAILS } } });
    await db.employee.deleteMany({ where: { code: { in: MADE_CODES } } });
  }

  function as(who: string) {
    return (path: string) =>
      request(http).get(path).set("Authorization", `Bearer ${token[who] as string}`);
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

    for (const [who, email] of [
      ["admin", "admin@kiosk.local"],
      ["hr", "hr@kiosk.local"],
      ["viewer", "viewer@kiosk.local"],
    ]) {
      const res = await request(http)
        .post("/auth/login")
        .send({ email, password: env.SEED_ADMIN_PASSWORD ?? "" });
      assert.equal(res.status, 200, `${who} could not sign in`);
      token[who as string] = res.body.accessToken;
    }

    const template = await db.employee.findFirstOrThrow({
      where: { active: true, legalEntityId: { not: null } },
    });
    for (const code of MADE_CODES) {
      const made = await db.employee.create({
        data: {
          code,
          fullName: `Phạm vi ${code}`,
          active: true,
          legalEntityId: template.legalEntityId,
          departmentId: template.departmentId,
        },
      });
      idOf.set(code, made.id);
    }
    await db.employee.update({
      where: { id: idOf.get(MINE) },
      data: { managerId: idOf.get(BOSS) },
    });

    const policy = await db.payrollPolicy.findFirstOrThrow();
    const period = await db.payrollPeriod.create({
      data: { year: PAY_YEAR, month: 1, startDate: new Date("1999-01-01"), endDate: new Date("1999-01-31") },
    });
    const run = await db.payrollRun.create({ data: { periodId: period.id } });
    await db.payslip.create({
      data: { runId: run.id, periodId: period.id, employeeId: idOf.get(STRANGER) as number, policyId: policy.id },
    });

    for (const [email, role, code] of [
      [BOSS_EMAIL, "MANAGER", BOSS],
      [MINE_EMAIL, "EMPLOYEE", MINE],
    ] as const) {
      await db.user.create({
        data: {
          email,
          passwordHash: await hashPassword(PASSWORD),
          role,
          employeeId: idOf.get(code) as number,
        },
      });
      const res = await request(http).post("/auth/login").send({ email, password: PASSWORD });
      assert.equal(res.status, 200, `${role} could not sign in`);
      token[role === "MANAGER" ? "boss" : "mine"] = res.body.accessToken;
    }
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("hides a stranger's record from an employee and from a manager", async () => {
    const stranger = idOf.get(STRANGER) as number;
    for (const who of ["mine", "boss"]) {
      const res = await as(who)(`/employees/${stranger}`);
      assert.equal(res.status, 404, `${who} reached a stranger's record`);
    }
  });

  it("shows a manager their own report, and an employee only themselves", async () => {
    assert.equal((await as("boss")(`/employees/${idOf.get(MINE) as number}`)).status, 200);
    assert.equal((await as("mine")(`/employees/${idOf.get(MINE) as number}`)).status, 200);
    assert.equal((await as("mine")(`/employees/${idOf.get(BOSS) as number}`)).status, 404);
  });

  it("keeps a stranger out of every list a narrowed viewer can ask for", async () => {
    const paths = [
      "/employees?take=200",
      `/timesheet?from=${MONTH.from}&to=${MONTH.to}`,
      "/requests",
      "/payslips",
    ];
    for (const who of ["mine", "boss"]) {
      for (const path of paths) {
        const res = await as(who)(path);
        assert.equal(res.status, 200, `${who} could not read ${path}`);
        const body = JSON.stringify(res.body);
        assert.ok(
          !body.includes(STRANGER) && !body.includes(`"employeeId":${idOf.get(STRANGER) as number}`),
          `${path} leaked a stranger to ${who}`,
        );
      }
    }
  });

  it("refuses to answer for a stranger even when asked by id", async () => {
    const stranger = idOf.get(STRANGER) as number;
    assert.equal((await as("mine")(`/tax-year/${stranger}?year=2026`)).status, 404);
    assert.equal((await as("mine")(`/employees/${stranger}/dependents`)).status, 404);
    const summary = await as("mine")(
      `/timesheet/summary?from=${MONTH.from}&to=${MONTH.to}&employeeId=${stranger}`,
    );
    assert.equal(summary.status, 200);
    assert.deepEqual(
      summary.body.rows,
      [],
      "a narrowed summary of somebody else is empty, not theirs",
    );
  });

  it("lets the unscoped roles see everyone", async () => {
    const stranger = idOf.get(STRANGER) as number;
    for (const who of ["admin", "hr"]) {
      assert.equal((await as(who)(`/employees/${stranger}`)).status, 200, `${who} lost sight`);
    }
  });

  // It is the default on a new account, so it has to be the narrowest role
  // rather than the widest (KEHOACH 9.4).
  it("narrows the default role to its own record", async () => {
    const stranger = idOf.get(STRANGER) as number;
    assert.equal((await as("viewer")(`/employees/${stranger}`)).status, 404);
    for (const path of ["/employees?take=200", "/attendance", "/payslips"]) {
      const res = await as("viewer")(path);
      assert.equal(res.status, 200, `viewer could not read ${path}`);
      assert.ok(
        !JSON.stringify(res.body).includes(STRANGER),
        `${path} handed the whole company to an account nobody assigned`,
      );
    }
  });

  it("keeps writing and exporting away from the roles that only read", async () => {
    const made = await request(http)
      .post("/employees")
      .set("Authorization", `Bearer ${token.mine as string}`)
      .send({ code: "E2ESC99", fullName: "Không được tạo" });
    assert.equal(made.status, 403);
    assert.equal((await as("mine")("/employees/export")).status, 403);
    assert.equal((await as("viewer")("/employees/export")).status, 403);
    assert.equal((await as("mine")("/dependents?state=PENDING")).status, 403);
  });

  it("keeps a stranger's payslip, pay record and consent out of reach", async () => {
    const stranger = idOf.get(STRANGER) as number;
    const other = await db.payslip.findFirst({
      where: { employeeId: { notIn: [idOf.get(MINE) as number, idOf.get(BOSS) as number] } },
      select: { id: true },
    });
    assert.ok(other, "the stranger's payslip was never made");

    const probes: [string, number][] = [
      [`/payslips/${other.id}`, 404],
      [`/payslips/${other.id}/compare`, 404],
      [`/employees/${stranger}/compensation`, 404],
      [`/biometric-consents/${stranger}`, 404],
    ];
    for (const [path, wanted] of probes) {
      const res = await as("mine")(path);
      assert.equal(res.status, wanted, `${path} answered ${res.status} to a stranger`);
    }
  });

  // Both take an employee id now, so both are a way in if either forgets.
  it("answers for somebody else only to a viewer who may read them", async () => {
    const stranger = idOf.get(STRANGER) as number;
    const report = idOf.get(MINE) as number;
    for (const path of [`/leave-balances?employeeId=${stranger}`, `/payslips?employeeId=${stranger}`]) {
      assert.equal((await as("mine")(path)).status, 404, `${path} answered for a stranger`);
    }
    assert.equal((await as("boss")(`/leave-balances?employeeId=${report}`)).status, 200);
    assert.equal((await as("hr")(`/leave-balances?employeeId=${stranger}`)).status, 200);
  });

  it("narrows a payslip list to the person asked about, not to everyone in scope", async () => {
    const stranger = idOf.get(STRANGER) as number;
    const res = await as("hr")(`/payslips?employeeId=${stranger}`);
    assert.equal(res.status, 200);
    const { rows } = res.body as { rows: { employeeId: number }[] };
    assert.ok(
      rows.every((row) => row.employeeId === stranger),
      "the filter was dropped and the whole scope came back",
    );
  });

  it("refuses a manager loop rather than letting the walk find one", async () => {
    const res = await request(http)
      .patch(`/employees/${idOf.get(BOSS) as number}`)
      .set("Authorization", `Bearer ${token.admin as string}`)
      .send({ managerId: idOf.get(MINE) as number });
    assert.equal(res.status, 409);
    assert.equal(res.body.message, "MANAGER_CYCLE");
    const boss = await db.employee.findUnique({ where: { id: idOf.get(BOSS) as number } });
    assert.equal(boss?.managerId, null, "the refused write left nothing behind");
  });

  it("moves who can see whom the moment the manager changes", async () => {
    const stranger = idOf.get(STRANGER) as number;
    assert.equal((await as("boss")(`/employees/${stranger}`)).status, 404);

    const moved = await request(http)
      .patch(`/employees/${stranger}`)
      .set("Authorization", `Bearer ${token.admin as string}`)
      .send({ managerId: idOf.get(BOSS) as number });
    assert.equal(moved.status, 200);

    // No waiting for a cache to lapse: the answer has to be right now.
    assert.equal((await as("boss")(`/employees/${stranger}`)).status, 200);
  });
});
