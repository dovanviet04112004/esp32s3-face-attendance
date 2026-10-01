import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { UNUSABLE_PASSWORD } from "../src/modules/auth/password.js";
import { EmployeesService } from "../src/modules/employees/employees.service.js";
import { dayAsDate } from "../src/modules/timesheet/local-day.js";
import { UsersService } from "../src/modules/users/users.service.js";

const LOCKED_ADMIN = "e2e-locked-admin@kiosk.local";
const SPARE_ADMIN = "e2e-spare-admin@kiosk.local";
const ADMIN_RECORD = "E2ELA01";
const SPARE_RECORD = "E2ELA02";
const LATER = "2049-12-31";
const DAY_MS = 86_400_000;

function lastAdmin(error: unknown): boolean {
  return (error as { message?: string }).message === "LAST_ADMIN";
}

// Alone: it counts every active administrator in the table, so it sets the others aside for its run.
describe("the last active administrator (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let users: UsersService;
  let employees: EmployeesService;
  let seedAdmin = "";
  let locked = "";
  let setAside: string[] = [];
  let adminRecord = 0;
  let entityId = "";
  let adminToken = "";
  let hrToken = "";

  async function signIn(email: string): Promise<string> {
    const res = await request(http).post("/auth/login").send({ email, password: validateEnv().SEED_ADMIN_PASSWORD ?? "" });
    assert.equal(res.status, 200, `${email} could not sign in`);
    return res.body.accessToken as string;
  }

  function yesterday(): Date {
    return new Date(dayAsDate(employees.today()).getTime() - DAY_MS);
  }

  async function standing(): Promise<[boolean, string | null, boolean]> {
    const [record, account] = await Promise.all([
      db.employee.findUniqueOrThrow({ where: { id: adminRecord } }),
      db.user.findUniqueOrThrow({ where: { id: seedAdmin } }),
    ]);
    return [record.active, record.leaveDate?.toISOString().slice(0, 10) ?? null, account.active];
  }

  before(async () => {
    void validateEnv();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    http = app.getHttpServer();
    db = app.get(PrismaService);
    users = app.get(UsersService);
    employees = app.get(EmployeesService);
    await db.user.deleteMany({ where: { email: { in: [LOCKED_ADMIN, SPARE_ADMIN] } } });
    await db.employee.deleteMany({ where: { code: { in: [ADMIN_RECORD, SPARE_RECORD] } } });

    seedAdmin = (await db.user.findUniqueOrThrow({ where: { email: "admin@kiosk.local" } })).id;
    locked = (
      await db.user.create({
        data: { email: LOCKED_ADMIN, passwordHash: UNUSABLE_PASSWORD, role: "ADMIN", active: false },
      })
    ).id;
    const others = await db.user.findMany({
      where: { role: "ADMIN", active: true, id: { not: seedAdmin } },
      select: { id: true },
    });
    setAside = others.map((one) => one.id);
    await db.user.updateMany({ where: { id: { in: setAside } }, data: { active: false } });

    entityId = (await db.legalEntity.findUniqueOrThrow({ where: { code: "DEFAULT" } })).id;
    adminRecord = (
      await db.employee.create({
        data: { code: ADMIN_RECORD, fullName: "Quản trị có hồ sơ", active: true, legalEntityId: entityId },
      })
    ).id;
    await db.user.update({ where: { id: seedAdmin }, data: { employeeId: adminRecord } });
    adminToken = await signIn("admin@kiosk.local");
    hrToken = await signIn("hr@kiosk.local");
  });

  after(async () => {
    await db.user.update({ where: { id: seedAdmin }, data: { employeeId: null, active: true } });
    await db.user.updateMany({ where: { id: { in: setAside } }, data: { active: true } });
    await db.user.deleteMany({ where: { email: { in: [LOCKED_ADMIN, SPARE_ADMIN] } } });
    await db.employee.deleteMany({ where: { code: { in: [ADMIN_RECORD, SPARE_RECORD] } } });
    await app.close();
  });

  it("counts a locked administrator out, so the only active one can be neither locked nor demoted", async () => {
    await assert.rejects(users.update(locked, seedAdmin, { active: false }), lastAdmin);
    await assert.rejects(users.update(locked, seedAdmin, { role: "VIEWER" }), lastAdmin);
    const held = await db.user.findUniqueOrThrow({ where: { id: seedAdmin } });
    assert.deepEqual([held.role, held.active], ["ADMIN", true]);
  });

  it("lets an administrator go once another active one exists", async () => {
    await users.update(seedAdmin, locked, { active: true });
    await users.update(seedAdmin, locked, { role: "VIEWER" });
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: locked } })).role, "VIEWER");
    await users.update(seedAdmin, locked, { active: false });
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: locked } })).active, false);
  });

  it("lets only an administrator record, move or call off the leaving of an administrator's record", async () => {
    const asHr = (method: "post" | "patch" | "delete") =>
      request(http)[method](`/employees/${adminRecord}/offboard`).set("Authorization", `Bearer ${hrToken}`);
    const recorded = await asHr("post").send({ leaveDate: employees.today() });
    assert.equal(recorded.status, 403, JSON.stringify(recorded.body));
    assert.equal(recorded.body.message, "LEAVING_ADMIN_ONLY");
    await db.employee.update({ where: { id: adminRecord }, data: { leaveDate: new Date(LATER) } });
    for (const res of [await asHr("patch").send({ leaveDate: employees.today() }), await asHr("delete")]) {
      assert.equal(res.status, 403, JSON.stringify(res.body));
      assert.equal(res.body.message, "LEAVING_ADMIN_ONLY");
    }
    assert.deepEqual(await standing(), [true, LATER, true], "the desk moved or closed an administrator's leaving");
  });

  it("refuses to close the record of the last active administrator, and leaves no date behind", async () => {
    await db.employee.update({ where: { id: adminRecord }, data: { active: true, leaveDate: null } });
    const res = await request(http)
      .post(`/employees/${adminRecord}/offboard`)
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ leaveDate: employees.today() });
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.message, "LAST_ADMIN");
    assert.deepEqual(await standing(), [true, null, true]);
  });

  it("never lets the nightly job close the last active administrator's record", async () => {
    await db.employee.update({ where: { id: adminRecord }, data: { active: true, leaveDate: yesterday() } });
    await db.user.update({ where: { id: seedAdmin }, data: { active: true } });
    const closed = await employees.closeDue(employees.today());
    assert.ok(!closed.includes(adminRecord), "the job closed the last administrator's record");
    const [open, , kept] = await standing();
    assert.deepEqual([open, kept], [true, true], "the job locked the last administrator out");
  });

  it("leaves an administrator's record out of a bulk leaving, and says why", async () => {
    await db.employee.update({ where: { id: adminRecord }, data: { active: true, leaveDate: null } });
    const res = await request(http)
      .post("/employees/bulk/offboard")
      .set("Authorization", `Bearer ${hrToken}`)
      .send({ employeeIds: [adminRecord], leaveDate: LATER });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(res.body.rows, [], "a bulk leaving took an administrator along");
    assert.deepEqual(
      (res.body.skipped as { employeeId: number; reason: string }[]).map((one) => [one.employeeId, one.reason]),
      [[adminRecord, "ADMIN_ACCOUNT"]],
    );
  });

  it("closes an administrator's record once another administrator stays active", async () => {
    const spare = await db.employee.create({
      data: { code: SPARE_RECORD, fullName: "Quản trị dự phòng", active: true, leaveDate: yesterday(), legalEntityId: entityId },
    });
    const account = await db.user.create({
      data: { email: SPARE_ADMIN, passwordHash: UNUSABLE_PASSWORD, role: "ADMIN", employeeId: spare.id },
    });
    const closed = await employees.closeDue(employees.today());
    assert.ok(closed.includes(spare.id), "an administrator's record stayed open beside another administrator");
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: account.id } })).active, false);
    assert.equal((await db.user.findUniqueOrThrow({ where: { id: seedAdmin } })).active, true);
  });
});
