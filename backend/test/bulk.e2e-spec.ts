import assert from "node:assert/strict";
import { after, before, describe, it, mock } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { UNUSABLE_PASSWORD } from "../src/modules/auth/password.js";
import { EmployeesService } from "../src/modules/employees/employees.service.js";
import { parseCsv } from "../src/modules/employees/import.js";
import { MqttService } from "../src/modules/mqtt/mqtt.service.js";
import { dayAsDate, localDay } from "../src/modules/timesheet/local-day.js";

const RAISE_BP = 100;
const BASE_SALARY = "20000000";
const EFFECTIVE_FROM = "2029-01-01";
const HIRED_FROM = "2028-01-01";
const REASON = "ANNUAL_REVIEW" as const;
// Its own people rather than the whole company: the company-wide figure is a
// measurement, and running one here starves the suites that watch a clock.
const CODES = ["NV9131B", "NV9132B", "NV9133B"];

describe("bulk raise (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let token = "";
  let employeeIds: number[] = [];

  async function sweep(): Promise<void> {
    await db.employee.deleteMany({ where: { code: { in: CODES } } });
  }

  function raise(): Promise<request.Response> {
    return request(http)
      .post("/compensation/bulk")
      .set("Authorization", `Bearer ${token}`)
      .send({ effectiveFrom: EFFECTIVE_FROM, percentBp: RAISE_BP, reason: REASON, employeeIds });
  }

  function written(): Promise<number> {
    return db.compensationRecord.count({
      where: { employeeId: { in: employeeIds }, effectiveFrom: new Date(EFFECTIVE_FROM) },
    });
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
    token = asAdmin.body.accessToken;

    const template = await db.employee.findFirstOrThrow({ where: { active: true } });
    employeeIds = [];
    for (const code of CODES) {
      const made = await db.employee.create({
        data: {
          code,
          fullName: `Thử nâng lương ${code}`,
          departmentId: template.departmentId,
          legalEntityId: template.legalEntityId,
        },
      });
      employeeIds.push(made.id);
      await db.compensationRecord.create({
        data: {
          employeeId: made.id,
          effectiveFrom: new Date(HIRED_FROM),
          baseSalary: BASE_SALARY,
          insuranceSalary: BASE_SALARY,
        },
      });
    }
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("writes one dated record per person", async () => {
    const res = await raise();
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.written, CODES.length);
    assert.equal(await written(), CODES.length);
  });

  it("raises by the rate it was given, leaving the old figure in place", async () => {
    const rows = await db.compensationRecord.findMany({
      where: { employeeId: { in: employeeIds }, effectiveFrom: new Date(EFFECTIVE_FROM) },
    });
    const wanted = (BigInt(BASE_SALARY) * BigInt(10_000 + RAISE_BP)) / 10_000n;
    for (const row of rows) {
      assert.equal(row.baseSalary.toFixed(0), wanted.toString());
    }
    const older = await db.compensationRecord.count({
      where: { employeeId: { in: employeeIds }, effectiveFrom: new Date(HIRED_FROM) },
    });
    assert.equal(older, CODES.length, "the raise overwrote what it should have appended to");
  });

  it("writes nothing extra when the same raise runs again", async () => {
    assert.equal((await raise()).status, 201);
    assert.equal(
      await written(),
      CODES.length,
      "a second run of the same raise wrote a second set of rows",
    );
  });
});

const PREFIX = "E2EBK";
const [BOSS_OLD, BOSS_NEW, AN, BINH, CHI, GONE, LEAVING, ELSEWHERE, CLASH] = [
  "01", "02", "03", "04", "05", "06", "07", "08", "09",
].map((tail) => `${PREFIX}${tail}`);
const PEOPLE = [BOSS_OLD, BOSS_NEW, AN, BINH, CHI, GONE, LEAVING, ELSEWHERE, CLASH];
const DOMAIN = "@bulk-e2e.test";
const DEVICE_ID = "kiosk-e2e-bulk";
const ROSTER_START = 7;
const SHIFT_NAME = "E2E bulk shift";
const SHIFT_FROM = "2030-03-01T00:00:00.000Z";
const RAISE_FROM = "2031-01-01";

interface Skip {
  employeeId: number;
  reason: string;
}

interface Plan {
  applied: boolean;
  rows: { employeeId: number; changes?: { field: string }[]; resend?: boolean; rosterVersion?: number | null }[];
  skipped: Skip[];
  requestsMoved?: number;
  rosterVersion?: number;
}

describe("bulk actions on the directory (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let token = "";
  const idOf = new Map<string, number>();
  const dept = { parent: "", child: "", other: "" };
  let entityB = "";
  let titleId = "";
  let shiftId = "";
  let requestId = "";

  const id = (code: string): number => idOf.get(code) as number;
  const ids = (...codes: string[]): number[] => codes.map(id);
  const reasons = (plan: Plan): [number, string][] =>
    plan.skipped.map((one): [number, string] => [one.employeeId, one.reason]).sort((a, b) => a[0] - b[0]);
  const rowIds = (plan: Plan): number[] => plan.rows.map((one) => one.employeeId).sort((a, b) => a - b);

  function post(path: string, body: object): Promise<request.Response> {
    return request(http).post(path).set("Authorization", `Bearer ${token}`).send(body);
  }

  // By subject alone: the people are new, and a bound on ts misses lines once the WSL clock steps back.
  function auditLines(action: string, subjectIds: number[]): Promise<number> {
    return db.auditLog.count({ where: { action, subjectId: { in: subjectIds.map(String) } } });
  }

  async function sweep(): Promise<void> {
    await db.user.deleteMany({ where: { OR: [{ email: { endsWith: DOMAIN } }, { employee: { code: { in: PEOPLE } } }] } });
    await db.request.deleteMany({ where: { employee: { code: { in: PEOPLE } } } });
    await db.deviceEnrollment.deleteMany({ where: { deviceId: DEVICE_ID } });
    await db.device.deleteMany({ where: { id: DEVICE_ID } });
    await db.shift.deleteMany({ where: { name: SHIFT_NAME } });
    await db.employee.updateMany({ where: { code: { in: PEOPLE } }, data: { managerId: null } });
    await db.employee.deleteMany({ where: { code: { in: PEOPLE } } });
    await db.department.deleteMany({ where: { code: `${PREFIX}-CHILD` } });
    await db.department.deleteMany({ where: { code: { startsWith: `${PREFIX}-` } } });
    await db.jobTitle.deleteMany({ where: { code: `${PREFIX}-JT` } });
    await db.legalEntity.deleteMany({ where: { code: `${PREFIX}-LE` } });
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
      .send({ email: "hr@kiosk.local", password: env.SEED_ADMIN_PASSWORD ?? "" });
    assert.equal(signedIn.status, 200, "hr could not sign in");
    token = signedIn.body.accessToken;

    const template = await db.employee.findFirstOrThrow({ where: { active: true, legalEntityId: { not: null } } });
    const entityA = template.legalEntityId as string;
    entityB = (await db.legalEntity.create({ data: { code: `${PREFIX}-LE`, name: "Pháp nhân thử" } })).id;
    const parent = await db.department.create({ data: { code: `${PREFIX}-PARENT`, name: "Khối thử", legalEntityId: entityA } });
    const child = await db.department.create({
      data: { code: `${PREFIX}-CHILD`, name: "Tổ thử", legalEntityId: entityA, parentId: parent.id },
    });
    const other = await db.department.create({ data: { code: `${PREFIX}-OTHER`, name: "Phòng khác", legalEntityId: entityB } });
    Object.assign(dept, { parent: parent.id, child: child.id, other: other.id });
    titleId = (await db.jobTitle.create({ data: { code: `${PREFIX}-JT`, name: "Chức danh thử" } })).id;

    const place: Record<string, { departmentId: string; legalEntityId: string }> = {
      [BOSS_OLD]: { departmentId: parent.id, legalEntityId: entityA },
      [BOSS_NEW]: { departmentId: parent.id, legalEntityId: entityA },
      [AN]: { departmentId: parent.id, legalEntityId: entityA },
      [ELSEWHERE]: { departmentId: other.id, legalEntityId: entityB },
    };
    for (const code of PEOPLE) {
      const made = await db.employee.create({
        data: {
          code,
          fullName: `Hàng loạt ${code}`,
          departmentId: place[code]?.departmentId ?? child.id,
          legalEntityId: place[code]?.legalEntityId ?? entityA,
          personalEmail: code === CHI ? null : code === CLASH ? "admin@kiosk.local" : `${code.toLowerCase()}${DOMAIN}`,
          active: code !== GONE,
          leaveDate: code === GONE ? new Date("2026-01-31") : code === LEAVING ? new Date("2031-12-31") : null,
        },
      });
      idOf.set(code, made.id);
    }
    await db.employee.updateMany({ where: { id: { in: ids(AN, BINH) } }, data: { managerId: id(BOSS_OLD) } });
    await db.user.create({
      data: { email: `boss-old${DOMAIN}`, passwordHash: UNUSABLE_PASSWORD, role: "MANAGER", employeeId: id(BOSS_OLD) },
    });
    await db.user.create({
      data: { email: `boss-new${DOMAIN}`, passwordHash: UNUSABLE_PASSWORD, role: "EMPLOYEE", employeeId: id(BOSS_NEW) },
    });
    const filed = await db.request.create({
      data: {
        employeeId: id(AN),
        kind: "REMOTE_WORK",
        state: "PENDING",
        fromDate: new Date("2030-12-01T00:00:00.000Z"),
        toDate: new Date("2030-12-02T00:00:00.000Z"),
        days: 2,
        reason: "e2e",
        approverId: id(BOSS_OLD),
      },
    });
    requestId = filed.id;
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("refuses a selection that names nobody, or both ways at once", async () => {
    const neither = await post("/employees/bulk/logins", {});
    assert.equal(neither.status, 400);
    assert.equal(neither.body.message, "SELECTION_INVALID");
    const both = await post("/employees/bulk/logins", { employeeIds: ids(AN), filter: { search: PREFIX } });
    assert.equal(both.body.message, "SELECTION_INVALID");
  });

  it("reads a filter as the directory reads it, a department with its whole branch", async () => {
    const listed = await request(http)
      .get(`/employees?search=${PREFIX}&departmentId=${dept.parent}&active=true&take=100`)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(listed.status, 200);
    const shown = (listed.body.rows as { id: number }[]).map((one) => one.id).sort((a, b) => a - b);
    assert.ok(shown.includes(id(BINH)), "the directory's department filter left out the branch below it");

    const res = await post("/employees/bulk/logins", { filter: { search: PREFIX, departmentId: dept.parent, active: true } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const plan = res.body as Plan;
    const reached = [...rowIds(plan), ...plan.skipped.map((one) => one.employeeId)].sort((a, b) => a - b);
    assert.deepEqual(reached, shown);
  });

  it("previews a title and department change without writing, skipping leavers and other entities", async () => {
    const body = { employeeIds: ids(AN, BINH, GONE, ELSEWHERE), departmentId: dept.child, jobTitleId: titleId };
    const res = await post("/employees/bulk/placement", body);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const plan = res.body as Plan;
    assert.equal(plan.applied, false);
    assert.deepEqual(rowIds(plan), ids(AN, BINH).sort((a, b) => a - b));
    assert.deepEqual(
      reasons(plan),
      [
        [id(GONE), "EMPLOYEE_HAS_LEFT"],
        [id(ELSEWHERE), "DEPARTMENT_OTHER_ENTITY"],
      ].sort((a, b) => (a[0] as number) - (b[0] as number)),
    );
    const an = await db.employee.findUniqueOrThrow({ where: { id: id(AN) } });
    assert.deepEqual([an.departmentId, an.jobTitleId], [dept.parent, null], "a preview wrote something");
  });

  it("applies it to exactly those people, one audit line each", async () => {
    const body = { employeeIds: ids(AN, BINH, GONE, ELSEWHERE), departmentId: dept.child, jobTitleId: titleId };
    const res = await post("/employees/bulk/placement?apply=true", body);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal((res.body as Plan).applied, true);
    const people = await db.employee.findMany({ where: { id: { in: ids(AN, BINH, ELSEWHERE) } }, orderBy: { code: "asc" } });
    assert.deepEqual(
      people.map((one) => [one.code, one.departmentId, one.jobTitleId]),
      [
        [AN, dept.child, titleId],
        [BINH, dept.child, titleId],
        [ELSEWHERE, dept.other, null],
      ],
    );
    assert.equal(await auditLines("employee.update", ids(AN, BINH, ELSEWHERE)), 2);
  });

  it("moves the pending requests and the manager roles with a new manager", async () => {
    const body = { employeeIds: ids(AN, BINH, BOSS_NEW), managerId: id(BOSS_NEW) };
    const seen = await post("/employees/bulk/placement", body);
    const plan = seen.body as Plan;
    assert.deepEqual(reasons(plan), [[id(BOSS_NEW), "MANAGER_CYCLE"]]);
    assert.equal(plan.requestsMoved, 1);

    const res = await post("/employees/bulk/placement?apply=true", body);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const moved = await db.employee.findMany({ where: { id: { in: ids(AN, BINH) } }, select: { managerId: true } });
    assert.deepEqual(moved.map((one) => one.managerId), [id(BOSS_NEW), id(BOSS_NEW)]);
    const waiting = await db.request.findUniqueOrThrow({ where: { id: requestId } });
    assert.equal(waiting.approverId, id(BOSS_NEW), "the waiting request stayed with a manager who lost sight of it");
    const roles = await db.user.findMany({ where: { employeeId: { in: ids(BOSS_OLD, BOSS_NEW) } }, include: { employee: true } });
    assert.deepEqual(
      roles.map((one) => [one.employee?.code, one.role]).sort(),
      [
        [BOSS_OLD, "EMPLOYEE"],
        [BOSS_NEW, "MANAGER"],
      ],
    );
    const line = await db.auditLog.findFirstOrThrow({
      where: { action: "employee.update", subjectId: String(id(AN)) },
      orderBy: { id: "desc" },
    });
    assert.deepEqual((line.meta as { managerId: unknown }).managerId, { from: id(BOSS_OLD), to: id(BOSS_NEW) });
  });

  it("previews logins with a reason for everyone it passes over, then opens them", async () => {
    const body = { employeeIds: ids(AN, BINH, CHI, GONE, LEAVING, CLASH) };
    const seen = await post("/employees/bulk/logins", body);
    assert.equal(seen.status, 201, JSON.stringify(seen.body));
    const plan = seen.body as Plan;
    assert.deepEqual(rowIds(plan), ids(AN, BINH).sort((a, b) => a - b));
    assert.deepEqual(
      reasons(plan),
      [
        [id(CHI), "NO_EMAIL"],
        [id(GONE), "EMPLOYEE_HAS_LEFT"],
        [id(LEAVING), "LEAVING_SCHEDULED"],
        [id(CLASH), "EMAIL_TAKEN"],
      ].sort((a, b) => (a[0] as number) - (b[0] as number)),
    );
    assert.equal(await db.user.count({ where: { employeeId: { in: ids(AN, BINH) } } }), 0, "a preview opened a login");

    const res = await post("/employees/bulk/logins?apply=true", body);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const opened = await db.user.findMany({ where: { employeeId: { in: ids(AN, BINH) } } });
    assert.equal(opened.length, 2);
    assert.ok(opened.every((one) => one.passwordHash === UNUSABLE_PASSWORD && one.role === "EMPLOYEE"));
    assert.equal(await db.passwordSetup.count({ where: { userId: { in: opened.map((one) => one.id) } } }), 2);
    assert.equal(
      await db.auditLog.count({ where: { action: "user.create", subjectId: { in: opened.map((one) => one.id) } } }),
      2,
    );
  });

  it("mails the link again to a login nobody used, and passes over one in use", async () => {
    await db.user.update({ where: { employeeId: id(BINH) }, data: { passwordHash: "scrypt$used$used" } });
    const res = await post("/employees/bulk/logins?apply=true", { employeeIds: ids(AN, BINH) });
    const plan = res.body as Plan;
    assert.deepEqual(plan.rows.map((one) => [one.employeeId, one.resend]), [[id(AN), true]]);
    assert.deepEqual(reasons(plan), [[id(BINH), "LOGIN_IN_USE"]]);
    const login = await db.user.findUniqueOrThrow({ where: { employeeId: id(AN) } });
    assert.equal(await db.passwordSetup.count({ where: { userId: login.id } }), 2, "resending minted no new link");
  });

  it("puts people on a kiosk with the roster moved once and consecutive versions", async () => {
    await db.device.create({ data: { id: DEVICE_ID, status: "APPROVED", rosterVersion: ROSTER_START } });
    await db.biometricConsent.createMany({
      data: ids(AN, BINH, CHI).map((employeeId) => ({ employeeId, noticeVersion: "e2e", method: "PAPER" })),
    });
    await db.deviceEnrollment.create({ data: { deviceId: DEVICE_ID, employeeId: id(CHI), state: "ENROLLED" } });
    const body = { deviceId: DEVICE_ID, employeeIds: ids(AN, BINH, CHI, GONE, ELSEWHERE) };

    const seen = await post("/employees/bulk/enrollments", body);
    assert.equal(seen.status, 201, JSON.stringify(seen.body));
    assert.deepEqual(rowIds(seen.body as Plan), ids(AN, BINH).sort((a, b) => a - b));
    assert.deepEqual(
      reasons(seen.body as Plan),
      [
        [id(CHI), "ALREADY_ON_KIOSK"],
        [id(GONE), "EMPLOYEE_HAS_LEFT"],
        [id(ELSEWHERE), "CONSENT_MISSING"],
      ].sort((a, b) => (a[0] as number) - (b[0] as number)),
    );
    const still = await db.device.findUniqueOrThrow({ where: { id: DEVICE_ID } });
    assert.equal(still.rosterVersion, ROSTER_START, "a preview moved the roster");

    const told: { op: string; employeeId: number; rosterVersion: number }[] = [];
    const mqtt = app.get(MqttService);
    const spy = mock.method(mqtt, "publishDown", async (_topic: string, _to: string, payload: never) => {
      told.push(payload);
    });
    const res = await post("/employees/bulk/enrollments?apply=true", body);
    spy.mock.restore();
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const done = await db.device.findUniqueOrThrow({ where: { id: DEVICE_ID } });
    assert.equal(done.rosterVersion, ROSTER_START + 2);
    assert.equal((res.body as Plan).rosterVersion, ROSTER_START + 2);
    assert.deepEqual(
      told.map((one) => [one.op, one.employeeId, one.rosterVersion]),
      [
        ["ASSIGN", id(AN), ROSTER_START + 1],
        ["ASSIGN", id(BINH), ROSTER_START + 2],
      ],
    );
    const held = await db.deviceEnrollment.findUniqueOrThrow({
      where: { deviceId_employeeId: { deviceId: DEVICE_ID, employeeId: id(CHI) } },
    });
    assert.equal(held.state, "ENROLLED", "a bulk run turned an enrolled face into a retake");
    assert.equal(await auditLines("enrollment.assign", ids(AN, BINH)), 2);
  });

  it("puts a filtered group on a shift and passes over the people who left", async () => {
    shiftId = (await db.shift.create({ data: { name: SHIFT_NAME, startTime: "07:00", endTime: "15:00" } })).id;
    const body = { filter: { search: PREFIX, departmentId: dept.child }, validFrom: SHIFT_FROM };
    const seen = await post(`/shifts/${shiftId}/assignments/bulk`, body);
    assert.equal(seen.status, 201, JSON.stringify(seen.body));
    assert.deepEqual(reasons(seen.body as Plan), [[id(GONE), "EMPLOYEE_HAS_LEFT"]]);
    assert.equal(await db.shiftAssignment.count({ where: { shiftId } }), 0, "a preview put somebody on the shift");

    const res = await post(`/shifts/${shiftId}/assignments/bulk?apply=true`, body);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const on = await db.shiftAssignment.findMany({ where: { shiftId }, select: { employeeId: true } });
    assert.deepEqual(
      on.map((one) => one.employeeId).sort((a, b) => a - b),
      rowIds(res.body as Plan),
    );
    assert.ok(!on.some((one) => one.employeeId === id(GONE)), "somebody who left went on the shift");
    assert.equal(await auditLines("shift.assign", on.map((one) => one.employeeId)), on.length);
  });

  it("raises pay for a department's whole branch", async () => {
    await db.compensationRecord.createMany({
      data: ids(BOSS_OLD, CHI).map((employeeId) => ({
        employeeId,
        effectiveFrom: new Date(HIRED_FROM),
        baseSalary: BASE_SALARY,
        insuranceSalary: BASE_SALARY,
      })),
    });
    const res = await post("/compensation/bulk/preview", {
      departmentId: dept.parent,
      effectiveFrom: RAISE_FROM,
      percentBp: RAISE_BP,
      reason: REASON,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const reached = (res.body as { employeeId: number }[]).map((one) => one.employeeId);
    assert.ok(reached.includes(id(CHI)), "a department raise left out the department below it");
    assert.ok(reached.includes(id(BOSS_OLD)));
  });
});

const FL = "E2EFL";
const [NONE_MAIL, NONE_BARE, INVITED, IN_USE, LOCKED, PAST_PAIR, DEAD_PAIR, LEFT_FL] = [
  "01", "02", "03", "04", "05", "06", "07", "08",
].map((tail) => `${FL}${tail}`);
const FILTERED = [NONE_MAIL, NONE_BARE, INVITED, IN_USE, LOCKED, PAST_PAIR, DEAD_PAIR, LEFT_FL];
const FL_DOMAIN = "@filters-e2e.test";
const LIVE_KIOSK = "kiosk-e2e-filters";
const DEAD_KIOSK = "kiosk-e2e-filters-off";
const FL_SHIFT = "E2E filters shift";
const kDayMs = 86_400_000;

describe("directory filters that match the bulk jobs (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let token = "";
  const idOf = new Map<string, number>();
  const codeOf = new Map<number, string>();

  const sorted = (codes: string[]): string[] => [...codes].sort();

  function get(path: string): Promise<request.Response> {
    return request(http).get(path).set("Authorization", `Bearer ${token}`);
  }

  function post(path: string, body: object): Promise<request.Response> {
    return request(http).post(path).set("Authorization", `Bearer ${token}`).send(body);
  }

  async function listed(query: string): Promise<{ codes: string[]; total: number }> {
    const res = await get(`/employees?search=${FL}&take=100&${query}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return { codes: sorted((res.body.rows as { code: string }[]).map((one) => one.code)), total: res.body.total as number };
  }

  async function sweep(): Promise<void> {
    await db.user.deleteMany({ where: { OR: [{ email: { endsWith: FL_DOMAIN } }, { employee: { code: { in: FILTERED } } }] } });
    await db.deviceEnrollment.deleteMany({ where: { deviceId: { in: [LIVE_KIOSK, DEAD_KIOSK] } } });
    await db.device.deleteMany({ where: { id: { in: [LIVE_KIOSK, DEAD_KIOSK] } } });
    await db.shift.deleteMany({ where: { name: FL_SHIFT } });
    await db.employee.deleteMany({ where: { code: { in: FILTERED } } });
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
      .send({ email: "hr@kiosk.local", password: env.SEED_ADMIN_PASSWORD ?? "" });
    assert.equal(signedIn.status, 200, "hr could not sign in");
    token = signedIn.body.accessToken;

    for (const code of FILTERED) {
      const made = await db.employee.create({
        data: {
          code,
          fullName: `Bộ lọc ${code}`,
          personalEmail: code === NONE_BARE ? null : `${code.toLowerCase()}${FL_DOMAIN}`,
          active: code !== LEFT_FL,
          leaveDate: code === LEFT_FL ? new Date("2026-01-31") : null,
        },
      });
      idOf.set(code, made.id);
      codeOf.set(made.id, code);
    }
    const id = (code: string): number => idOf.get(code) as number;
    const logins: [string, { passwordHash: string; active: boolean }][] = [
      [INVITED, { passwordHash: UNUSABLE_PASSWORD, active: true }],
      [IN_USE, { passwordHash: "scrypt$used$used", active: true }],
      [LOCKED, { passwordHash: "scrypt$used$used", active: false }],
    ];
    for (const [code, login] of logins) {
      await db.user.create({ data: { email: `login-${code.toLowerCase()}${FL_DOMAIN}`, role: "EMPLOYEE", employeeId: id(code), ...login } });
    }
    await db.biometricConsent.createMany({
      data: [NONE_MAIL, INVITED, IN_USE, LOCKED, DEAD_PAIR].map((code) => ({ employeeId: id(code), noticeVersion: "e2e", method: "PAPER" })),
    });
    await db.biometricConsent.create({
      data: { employeeId: id(PAST_PAIR), noticeVersion: "e2e", method: "PAPER", state: "WITHDRAWN", withdrawnAt: new Date() },
    });
    await db.device.createMany({
      data: [
        { id: LIVE_KIOSK, status: "APPROVED" },
        { id: DEAD_KIOSK, status: "REVOKED" },
      ],
    });
    await db.deviceEnrollment.createMany({
      data: [
        { deviceId: LIVE_KIOSK, employeeId: id(INVITED), state: "ASSIGNED" },
        { deviceId: LIVE_KIOSK, employeeId: id(IN_USE), state: "ENROLLED" },
        { deviceId: LIVE_KIOSK, employeeId: id(LOCKED), state: "RETAKE" },
        { deviceId: LIVE_KIOSK, employeeId: id(PAST_PAIR), state: "REVOKED" },
        { deviceId: DEAD_KIOSK, employeeId: id(DEAD_PAIR), state: "ENROLLED" },
      ],
    });
    const today = dayAsDate(localDay(new Date(), env.APP_TIMEZONE)).getTime();
    const day = (offset: number): Date => new Date(today + offset * kDayMs);
    const shift = await db.shift.create({ data: { name: FL_SHIFT, startTime: "08:00", endTime: "17:00" } });
    await db.shiftAssignment.createMany({
      data: [
        { employeeId: id(NONE_MAIL), validFrom: day(-10), validTo: null },
        { employeeId: id(INVITED), validFrom: day(0), validTo: day(0) },
        { employeeId: id(IN_USE), validFrom: day(-30), validTo: day(-1) },
        { employeeId: id(LOCKED), validFrom: day(1), validTo: null },
        { employeeId: id(PAST_PAIR), validFrom: day(-400), validTo: null },
      ].map((one) => ({ ...one, shiftId: shift.id })),
    });
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  const EXPECTED: Record<string, Record<string, string[]>> = {
    account: {
      none: [NONE_MAIL, NONE_BARE, PAST_PAIR, DEAD_PAIR],
      invited: [INVITED],
      active: [IN_USE],
      locked: [LOCKED],
    },
    face: {
      unassigned: [NONE_MAIL, NONE_BARE, PAST_PAIR, DEAD_PAIR],
      waiting: [INVITED, LOCKED],
      enrolled: [IN_USE],
      noConsent: [NONE_BARE, PAST_PAIR],
      noEmail: [NONE_BARE],
    },
    shift: {
      none: [NONE_BARE, IN_USE, LOCKED, DEAD_PAIR],
      some: [NONE_MAIL, INVITED, PAST_PAIR],
    },
  };

  it("lists exactly the people each option names, today being the company's", async () => {
    for (const [filter, options] of Object.entries(EXPECTED)) {
      for (const [option, codes] of Object.entries(options)) {
        const found = await listed(`active=true&${filter}=${option}`);
        assert.deepEqual(found.codes, sorted(codes), `${filter}=${option}`);
      }
    }
    const gone = await listed("active=false&account=none");
    assert.deepEqual(gone.codes, [LEFT_FL], "the account filter ignored the status filter");
  });

  it("counts every option under the other filters, and each count is what the list shows", async () => {
    const res = await get(`/employees/counts/readiness?search=${FL}&active=true`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const everyone = FILTERED.length - 1;
    for (const [filter, options] of Object.entries(EXPECTED)) {
      const wanted = Object.fromEntries(Object.entries(options).map(([option, codes]) => [option, codes.length]));
      assert.deepEqual(res.body[filter], { ...wanted, all: everyone }, filter);
    }

    const narrowed = await get(`/employees/counts/readiness?search=${FL}&active=true&account=none`);
    assert.equal(narrowed.body.account.none, EXPECTED.account.none.length, "the account counts filtered on themselves");
    assert.equal(narrowed.body.face.all, EXPECTED.account.none.length);
    for (const filter of ["face", "shift"]) {
      for (const option of Object.keys(EXPECTED[filter])) {
        const found = await listed(`active=true&account=none&${filter}=${option}`);
        assert.equal(narrowed.body[filter][option], found.total, `${filter}=${option} under account=none`);
      }
    }

    const status = await get(`/employees/counts?search=${FL}&account=none`);
    assert.deepEqual(status.body, { active: EXPECTED.account.none.length, left: 1 });
  });

  it("refuses an option it does not know, in the list and in a bulk filter", async () => {
    const bad = await get(`/employees?search=${FL}&account=everyone`);
    assert.equal(bad.status, 400);
    assert.equal(bad.body.message, "VALIDATION_FAILED");
    assert.ok((bad.body.fields as string[]).includes("account"));
    const bulk = await post("/employees/bulk/logins", { filter: { search: FL, face: "someone" } });
    assert.equal(bulk.status, 400);
    assert.equal(bulk.body.message, "VALIDATION_FAILED");
  });

  it("exports exactly the people a filter lists", async () => {
    const res = await get(`/employees/export?search=${FL}&active=true&face=waiting&format=csv`);
    assert.equal(res.status, 200);
    const codes = parseCsv(res.text)
      .slice(1)
      .filter((cells) => cells.length > 1)
      .map((cells) => cells[0] ?? "");
    assert.deepEqual(sorted(codes), sorted(EXPECTED.face.waiting));
  });

  it("puts everyone on no kiosk on one without passing anybody over as already there", async () => {
    const res = await post("/employees/bulk/enrollments", { deviceId: LIVE_KIOSK, filter: { search: FL, active: true, face: "unassigned" } });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const plan = res.body as Plan;
    assert.deepEqual(sorted(plan.rows.map((one) => codeOf.get(one.employeeId) ?? "")), sorted([NONE_MAIL, DEAD_PAIR]));
    assert.deepEqual(
      sorted(plan.skipped.map((one) => `${codeOf.get(one.employeeId)}:${one.reason}`)),
      sorted([`${NONE_BARE}:CONSENT_MISSING`, `${PAST_PAIR}:CONSENT_MISSING`]),
    );
  });

  it("invites everyone without an account and passes nobody over for already having one", async () => {
    const filter = { search: FL, active: true, account: "none" };
    const first = await post("/employees/bulk/logins", { filter });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    const seen = first.body as Plan;
    assert.deepEqual(
      seen.skipped.map((one) => [codeOf.get(one.employeeId), one.reason]),
      [[NONE_BARE, "NO_EMAIL"]],
      "the account filter let somebody with a login into the run",
    );

    const missing = await listed("active=true&face=noEmail");
    assert.deepEqual(missing.codes, [NONE_BARE]);
    await db.employee.update({ where: { id: idOf.get(NONE_BARE) }, data: { personalEmail: `bare${FL_DOMAIN}` } });

    const again = await post("/employees/bulk/logins", { filter });
    const plan = again.body as Plan;
    assert.deepEqual(plan.skipped, []);
    assert.deepEqual(sorted(plan.rows.map((one) => codeOf.get(one.employeeId) ?? "")), sorted(EXPECTED.account.none));
    const done = await post("/employees/bulk/logins?apply=true", { filter });
    assert.equal(done.status, 201, JSON.stringify(done.body));
    assert.equal((done.body as Plan).rows.length, EXPECTED.account.none.length);

    const left = await listed("active=true&account=none");
    assert.deepEqual(left.codes, []);
    const resend = await post("/employees/bulk/logins", { filter: { search: FL, active: true, account: "invited" } });
    const resent = resend.body as Plan;
    assert.deepEqual(resent.skipped, []);
    assert.ok(resent.rows.every((one) => one.resend === true), "an invited login was offered a second account");
    assert.equal(resent.rows.length, EXPECTED.account.none.length + 1);
  });
});

const OF = "E2EOF";
const [TODAY_A, TODAY_B, AHEAD, OF_GONE, OF_SCHEDULED] = ["01", "02", "03", "04", "05"].map((tail) => `${OF}${tail}`);
const LEAVERS = [TODAY_A, TODAY_B, AHEAD, OF_GONE, OF_SCHEDULED];
const OF_DOMAIN = "@offboard-bulk-e2e.test";
const kCloseWaitMs = 15_000;
const kPollMs = 250;
const kAheadDays = 30;

interface LeavingPlan {
  applied: boolean;
  leaveDate: string;
  closesNow: boolean;
  rows: { employeeId: number; requests: number }[];
  skipped: Skip[];
}

describe("bulk offboarding (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let employees: EmployeesService;
  let token = "";
  let hrUserId = "";
  let hrEmployeeId = 0;
  let today = "";
  const idOf = new Map<string, number>();
  const id = (code: string): number => idOf.get(code) as number;
  const ids = (...codes: string[]): number[] => codes.map(id);
  const byId = (a: number, b: number): number => a - b;

  function offboard(body: object, apply = false): Promise<request.Response> {
    return request(http)
      .post(`/employees/bulk/offboard${apply ? "?apply=true" : ""}`)
      .set("Authorization", `Bearer ${token}`)
      .send(body);
  }

  async function closedWithin(employeeIds: number[], waitMs: number): Promise<boolean> {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const open = await db.employee.count({ where: { id: { in: employeeIds }, active: true } });
      if (open === 0) {
        return true;
      }
      await new Promise((done) => setTimeout(done, kPollMs));
    }
    return false;
  }

  async function sweep(): Promise<void> {
    await db.user.deleteMany({ where: { email: { endsWith: OF_DOMAIN } } });
    await db.request.deleteMany({ where: { employee: { code: { in: LEAVERS } } } });
    await db.employee.deleteMany({ where: { code: { in: LEAVERS } } });
  }

  before(async () => {
    const env = validateEnv();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    http = app.getHttpServer();
    db = app.get(PrismaService);
    employees = app.get(EmployeesService);
    today = employees.today();
    await sweep();

    const signedIn = await request(http)
      .post("/auth/login")
      .send({ email: "hr@kiosk.local", password: env.SEED_ADMIN_PASSWORD ?? "" });
    assert.equal(signedIn.status, 200, "hr could not sign in");
    token = signedIn.body.accessToken;
    const hr = await db.user.findUniqueOrThrow({ where: { email: "hr@kiosk.local" } });
    hrUserId = hr.id;
    hrEmployeeId = hr.employeeId as number;

    const template = await db.employee.findFirstOrThrow({ where: { active: true, legalEntityId: { not: null } } });
    for (const code of LEAVERS) {
      const made = await db.employee.create({
        data: {
          code,
          fullName: `Nghỉ loạt ${code}`,
          legalEntityId: template.legalEntityId,
          active: code !== OF_GONE,
          leaveDate: code === OF_GONE ? new Date("2026-01-31") : code === OF_SCHEDULED ? new Date("2031-12-31") : null,
        },
      });
      idOf.set(code, made.id);
    }
    await db.user.create({
      data: { email: `today-a${OF_DOMAIN}`, passwordHash: UNUSABLE_PASSWORD, role: "EMPLOYEE", employeeId: id(TODAY_A) },
    });
    await db.request.create({
      data: {
        employeeId: id(TODAY_B),
        kind: "REMOTE_WORK",
        state: "PENDING",
        fromDate: new Date("2030-12-01T00:00:00.000Z"),
        toDate: new Date("2030-12-02T00:00:00.000Z"),
        days: 2,
        reason: "e2e",
      },
    });
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("previews one last day without writing, passing over leavers, the scheduled and the clicker", async () => {
    const res = await offboard({ employeeIds: [...ids(TODAY_A, TODAY_B, OF_GONE, OF_SCHEDULED), hrEmployeeId], leaveDate: today });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const plan = res.body as LeavingPlan;
    assert.deepEqual([plan.applied, plan.closesNow, plan.leaveDate], [false, true, today]);
    assert.deepEqual(plan.rows.map((one) => one.employeeId).sort(byId), ids(TODAY_A, TODAY_B).sort(byId));
    assert.equal(plan.rows.find((one) => one.employeeId === id(TODAY_B))?.requests, 1);
    assert.deepEqual(
      plan.skipped.map((one): [number, string] => [one.employeeId, one.reason]).sort((a, b) => a[0] - b[0]),
      (
        [
          [id(OF_GONE), "EMPLOYEE_HAS_LEFT"],
          [id(OF_SCHEDULED), "LEAVING_SCHEDULED"],
          [hrEmployeeId, "SELF"],
        ] as [number, string][]
      ).sort((a, b) => a[0] - b[0]),
    );
    const untouched = await db.employee.findUniqueOrThrow({ where: { id: id(TODAY_A) } });
    assert.equal(untouched.leaveDate, null, "a preview wrote a last day");
  });

  it("records the day for exactly those people, and the queue closes them in the clicker's name", async () => {
    const res = await offboard(
      { employeeIds: [...ids(TODAY_A, TODAY_B, OF_GONE, OF_SCHEDULED), hrEmployeeId], leaveDate: today, reason: "e2e" },
      true,
    );
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal((res.body as LeavingPlan).applied, true);
    const offboarded = await db.auditLog.count({
      where: { action: "employee.offboard", subjectId: { in: ids(TODAY_A, TODAY_B).map(String) } },
    });
    assert.equal(offboarded, 2);
    assert.ok(await closedWithin(ids(TODAY_A, TODAY_B), kCloseWaitMs), "the people queue never closed the records");
    const login = await db.user.findUniqueOrThrow({ where: { email: `today-a${OF_DOMAIN}` } });
    assert.equal(login.active, false, "the login of a closed record stayed open");
    const closedBy = await db.auditLog.findMany({
      where: { action: "employee.deactivate", subjectId: { in: ids(TODAY_A, TODAY_B).map(String) } },
      select: { actorId: true },
    });
    assert.deepEqual(closedBy.map((one) => one.actorId), [hrUserId, hrUserId]);
    const self = await db.employee.findUniqueOrThrow({ where: { id: hrEmployeeId } });
    assert.deepEqual([self.active, self.leaveDate], [true, null], "the clicker's own record was offboarded");
  });

  it("closes nothing twice when the job runs again", async () => {
    assert.deepEqual(await employees.closeMany(ids(TODAY_A, TODAY_B), today, hrUserId), []);
    const lines = await db.auditLog.count({
      where: { action: "employee.deactivate", subjectId: { in: ids(TODAY_A, TODAY_B).map(String) } },
    });
    assert.equal(lines, 2);
  });

  it("only schedules a day still ahead", async () => {
    const ahead = new Date(dayAsDate(today).getTime() + kAheadDays * 86_400_000).toISOString().slice(0, 10);
    const res = await offboard({ employeeIds: ids(AHEAD), leaveDate: ahead }, true);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal((res.body as LeavingPlan).closesNow, false);
    const person = await db.employee.findUniqueOrThrow({ where: { id: id(AHEAD) } });
    assert.deepEqual([person.active, person.leaveDate?.toISOString().slice(0, 10)], [true, ahead]);
  });
});
