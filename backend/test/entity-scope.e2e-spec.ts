import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import type { Role } from "@prisma/client";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { hashPassword } from "../src/modules/auth/password.js";
import { signIn } from "./fixtures.js";
import { clearDeskNotices } from "./teardown.js";

// Two entities of this suite's own: the limited desks answer for A, and B is the company next door.
const A_CODE = "E2E-SCOPE-A";
const B_CODE = "E2E-SCOPE-B";
const ENTITY_CODES = [A_CODE, B_CODE];
const ALPHA = "NV9S01";
const BRAVO = "NV9S02";
const CLERK = "NV9S10";
const PURSER = "NV9S11";
const SPARE = "NV9S12";
const CODES = [ALPHA, BRAVO, CLERK, PURSER, SPARE];
const MAIL = (code: string) => `e2e-scope-${code.toLowerCase()}@kiosk.local`;
const PASSWORD = "kiosk-e2e-scope-password";
const YEAR = 2026;
// A token from the cutoff's own second is judged by its open session (KEHOACH 9.23), so a sign-in after one waits.
const SECOND_MS = 1_100;
// A finished Tuesday no other suite builds.
const BUILD_DAY = "2026-04-21";
const BUILD_WAIT_MS = 30_000;
const POLL_MS = 200;

describe("a desk held to some legal entities reads and writes only theirs (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  const token: Record<"admin" | "hr" | "alpha" | "bravo" | "clerk" | "purser", string> = {
    admin: "",
    hr: "",
    alpha: "",
    bravo: "",
    clerk: "",
    purser: "",
  };
  const idOf = new Map<string, number>();
  const userOf = new Map<string, string>();
  let aId = "";
  let bId = "";
  let bDepartment = "";
  let bPeriod = "";

  async function sweep(): Promise<void> {
    const entities = { legalEntity: { is: { code: { in: ENTITY_CODES } } } };
    await clearDeskNotices(db, CODES);
    await db.certificate.deleteMany({ where: { employee: { code: { in: CODES } } } });
    await db.user.deleteMany({ where: { email: { in: CODES.map(MAIL) } } });
    await db.payrollPeriod.deleteMany({ where: entities });
    await db.holiday.deleteMany({ where: entities });
    await db.employee.deleteMany({ where: { code: { in: CODES } } });
    await db.department.deleteMany({ where: entities });
    await db.legalEntity.deleteMany({ where: { code: { in: ENTITY_CODES } } });
  }

  function as(who: keyof typeof token) {
    const bearer = () => `Bearer ${token[who]}`;
    return {
      get: (path: string) => request(http).get(path).set("Authorization", bearer()),
      post: (path: string, body?: object) => request(http).post(path).set("Authorization", bearer()).send(body ?? {}),
      patch: (path: string, body: object) => request(http).patch(path).set("Authorization", bearer()).send(body),
    };
  }

  async function hire(code: string, legalEntityId: string, departmentId: string | null, role: Role | null): Promise<void> {
    const made = await db.employee.create({
      data: {
        code,
        fullName: `Phạm vi ${code}`,
        active: true,
        legalEntityId,
        departmentId,
        personalEmail: MAIL(code),
        ...(role ? { login: { create: { email: MAIL(code), passwordHash: await hashPassword(PASSWORD), role } } } : {}),
      },
      include: { login: { select: { id: true } } },
    });
    idOf.set(code, made.id);
    if (made.login) {
      userOf.set(code, made.login.id);
    }
  }

  async function seatedOn(certificateId: string): Promise<string[]> {
    const rows = await db.notification.findMany({
      where: { kind: "REQUEST_WAITING", subjectId: certificateId, leftAt: null },
      select: { userId: true },
    });
    return rows.map((row) => row.userId);
  }

  before(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    http = app.getHttpServer();
    db = app.get(PrismaService);
    await sweep();

    aId = (await db.legalEntity.create({ data: { code: A_CODE, name: "Pháp nhân phạm vi A" } })).id;
    bId = (await db.legalEntity.create({ data: { code: B_CODE, name: "Pháp nhân phạm vi B" } })).id;
    const aDepartment = (await db.department.create({ data: { code: "E2E-SCOPE-DA", name: "Phòng A", legalEntityId: aId } })).id;
    bDepartment = (await db.department.create({ data: { code: "E2E-SCOPE-DB", name: "Phòng B", legalEntityId: bId } })).id;
    await hire(ALPHA, aId, aDepartment, "EMPLOYEE");
    await hire(BRAVO, bId, bDepartment, "EMPLOYEE");
    // The clerk's own record sits in B while the account answers for A only, as at a parent company.
    await hire(CLERK, bId, bDepartment, "HR");
    await hire(PURSER, aId, aDepartment, "PAYROLL");
    await hire(SPARE, aId, aDepartment, null);
    await db.userEntity.createMany({
      data: [CLERK, PURSER].map((code) => ({ userId: userOf.get(code) ?? "", legalEntityId: aId })),
    });
    bPeriod = (
      await db.payrollPeriod.create({
        data: {
          legalEntityId: bId,
          year: YEAR,
          month: 3,
          startDate: new Date(Date.UTC(YEAR, 2, 1)),
          endDate: new Date(Date.UTC(YEAR, 2, 31)),
        },
      })
    ).id;

    const seeded = validateEnv().SEED_ADMIN_PASSWORD ?? "";
    token.admin = await signIn(http, "admin@kiosk.local", seeded);
    token.hr = await signIn(http, "hr@kiosk.local", seeded);
    for (const [who, code] of [["alpha", ALPHA], ["bravo", BRAVO], ["clerk", CLERK], ["purser", PURSER]] as const) {
      token[who] = await signIn(http, MAIL(code), PASSWORD);
    }
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("carries the entities on the token, and none for a whole-group desk", async () => {
    const limited = await as("clerk").get("/auth/me");
    assert.deepEqual(limited.body.ent, [aId]);
    const whole = await as("hr").get("/auth/me");
    assert.equal(whole.body.ent, undefined, "a whole-group desk carries a list");
  });

  it("lists and opens only the people of its entities, and always its own record", async () => {
    const listed = await as("clerk").get("/employees?search=NV9S&take=50");
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    const codes = (listed.body.rows as { code: string }[]).map((row) => row.code);
    assert.ok(codes.includes(ALPHA), "the clerk's own entity is missing from the list");
    assert.ok(!codes.includes(BRAVO), "the list shows the company next door");

    const away = await as("clerk").get(`/employees/${idOf.get(BRAVO)}`);
    assert.equal(away.status, 404);
    assert.equal(away.body.message, "EMPLOYEE_NOT_FOUND");
    assert.equal((await as("clerk").get(`/employees/${idOf.get(ALPHA)}`)).status, 200);
    assert.equal((await as("clerk").get(`/employees/${idOf.get(CLERK)}`)).status, 200, "the clerk lost their own record");
  });

  it("moves nobody into an entity it does not answer for", async () => {
    const intoB = await as("clerk").patch(`/employees/${idOf.get(ALPHA)}`, { legalEntityId: bId });
    assert.equal(intoB.status, 404, JSON.stringify(intoB.body));
    assert.equal(intoB.body.message, "LEGAL_ENTITY_NOT_FOUND");
    const intoB2 = await as("clerk").patch(`/employees/${idOf.get(ALPHA)}`, { departmentId: bDepartment });
    assert.equal(intoB2.status, 404, JSON.stringify(intoB2.body));
    assert.equal(intoB2.body.message, "DEPARTMENT_NOT_FOUND");
    const alpha = await db.employee.findUniqueOrThrow({ where: { id: idOf.get(ALPHA) } });
    assert.equal(alpha.legalEntityId, aId, "a refused move still moved the person");
  });

  it("finds nobody of another entity in the global search", async () => {
    const hitsOf = async (term: string) =>
      ((await as("clerk").get(`/search?q=${term}`)).body.hits as { kind: string; title: string }[]).filter(
        (hit) => hit.kind === "employee",
      );
    assert.equal((await hitsOf(ALPHA)).length, 1);
    assert.deepEqual(await hitsOf(BRAVO), [], "the search names a person of the company next door");
  });

  it("reads the shared catalogues and changes none of them", async () => {
    assert.equal((await as("clerk").get("/leave-types")).status, 200);
    const added = await as("clerk").post("/leave-types", { code: "E2E-SCOPE", name: "Phép phạm vi" });
    assert.equal(added.status, 403);
    assert.equal(added.body.message, "GROUP_WIDE_ONLY");
    const renamed = await as("clerk").patch("/job-titles/any", { name: "Đổi tên" });
    assert.equal(renamed.status, 403);
    assert.equal(renamed.body.message, "GROUP_WIDE_ONLY");
  });

  it("keeps holidays to its entities: none for the group, none for the company next door", async () => {
    const group = await as("clerk").post("/holidays", { date: "2026-12-29", name: "Nghỉ cả nhóm" });
    assert.equal(group.status, 403);
    assert.equal(group.body.message, "GROUP_WIDE_ONLY");
    const away = await as("clerk").post("/holidays", { legalEntityId: bId, date: "2026-12-29", name: "Nghỉ của B" });
    assert.equal(away.status, 404);
    assert.equal(away.body.message, "LEGAL_ENTITY_NOT_FOUND");
    const own = await as("clerk").post("/holidays", { legalEntityId: aId, date: "2026-12-29", name: "Nghỉ của A" });
    assert.equal(own.status, 201, JSON.stringify(own.body));
  });

  it("offers only its entities, and their periods", async () => {
    const entities = await as("purser").get("/legal-entities");
    assert.deepEqual(
      (entities.body as { id: string }[]).map((one) => one.id),
      [aId],
      "the entity picker offers what the account does not answer for",
    );
    const periods = (await as("purser").get("/payroll-periods")).body as { id: string }[];
    assert.ok(!periods.some((one) => one.id === bPeriod), "the period list shows the company next door");
    const runs = await as("purser").get(`/payroll-periods/${bPeriod}/runs`);
    assert.equal(runs.status, 404);
    assert.equal(runs.body.message, "PERIOD_NOT_FOUND");
    const held = await as("purser").get(`/payroll-periods/${bPeriod}/held-punches`);
    assert.deepEqual([held.status, held.body.message], [404, "PERIOD_NOT_FOUND"], "the desk counted the punches of the company next door");

    const away = await as("purser").post("/payroll-periods", { legalEntityId: bId, year: YEAR, month: 4 });
    assert.equal(away.status, 404, JSON.stringify(away.body));
    assert.equal(away.body.message, "LEGAL_ENTITY_NOT_FOUND");
    const unnamed = await as("purser").post("/payroll-periods", { year: YEAR, month: 4 });
    assert.equal(unnamed.status, 201, JSON.stringify(unnamed.body));
    assert.equal(unnamed.body.legalEntityId, aId, "an unnamed period went to an entity the desk does not answer for");
  });

  it("files no social-insurance return for the company next door", async () => {
    const filed = await as("purser").get(`/reports/d02-lt?legalEntityId=${bId}&on=2026-03-01`);
    assert.equal(filed.status, 404);
    // The route sets its CSV type ahead of the handler, so its error body arrives labelled as CSV.
    assert.equal(JSON.parse(filed.text).message, "LEGAL_ENTITY_NOT_FOUND");
  });

  it("rebuilds the days of its own entities only", async () => {
    const date = new Date(`${BUILD_DAY}T00:00:00.000Z`);
    const own = idOf.get(SPARE) as number;
    // Worked with no punch behind it: any build that reached B would rewrite it as absent.
    const nextDoor = await db.attendanceDay.create({
      data: { employeeId: idOf.get(BRAVO) as number, date, state: "WORKED", workedMinutes: 480, punchCount: 2 },
    });
    const queued = await as("purser").post("/timesheet/build", { from: BUILD_DAY, to: BUILD_DAY });
    assert.equal(queued.status, 201, JSON.stringify(queued.body));
    let state = "waiting";
    for (let waited = 0; waited < BUILD_WAIT_MS && ["waiting", "active"].includes(state); waited += POLL_MS) {
      await sleep(POLL_MS);
      state = (await as("purser").get(`/timesheet/build/${queued.body.jobId}`)).body.state as string;
    }
    assert.equal(state, "completed");
    assert.ok(await db.attendanceDay.findFirst({ where: { employeeId: own, date } }), "the build left out the desk's own entity");
    const kept = await db.attendanceDay.findFirstOrThrow({ where: { id: nextDoor.id } });
    assert.deepEqual(
      [kept.state, kept.updatedAt.getTime()],
      ["WORKED", nextDoor.updatedAt.getTime()],
      "a desk of A rebuilt a day of the company next door",
    );
  });

  it("seats its desk on the work of its entities only, while a whole-group desk sees both", async () => {
    const asked = async (who: "alpha" | "bravo") => {
      const res = await as(who).post("/certificates", { kind: "EMPLOYMENT", purpose: "e2e phạm vi" });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      return res.body.id as string;
    };
    const fromA = await asked("alpha");
    const fromB = await asked("bravo");
    const hr = await db.user.findUniqueOrThrow({ where: { email: "hr@kiosk.local" }, select: { id: true } });

    const onA = await seatedOn(fromA);
    const onB = await seatedOn(fromB);
    assert.ok(onA.includes(userOf.get(CLERK) ?? ""), "the clerk was not told of work in its entity");
    assert.ok(!onB.includes(userOf.get(CLERK) ?? ""), "the clerk was told of work next door");
    assert.ok(!onB.includes(userOf.get(PURSER) ?? ""), "the purser was told of work next door");
    assert.ok(onA.includes(hr.id) && onB.includes(hr.id), "a whole-group desk lost one entity's work");

    const listed = ((await as("clerk").get("/certificates?take=50")).body.rows as { id: string }[]).map((row) => row.id);
    assert.ok(listed.includes(fromA) && !listed.includes(fromB), JSON.stringify(listed));
    const away = await as("clerk").get(`/certificates/${fromB}`);
    assert.equal(away.status, 404);
    assert.equal(away.body.message, "CERTIFICATE_NOT_FOUND");
    assert.equal((await as("hr").get(`/certificates/${fromB}`)).status, 200, "a whole-group desk lost the company next door");
  });

  it("keeps its own rows though its record sits in another entity", async () => {
    const mine = await as("clerk").post("/certificates", { kind: "EMPLOYMENT", purpose: "e2e của chính mình" });
    assert.equal(mine.status, 201, JSON.stringify(mine.body));
    assert.equal((await as("clerk").get(`/certificates/${mine.body.id}`)).status, 200, "the clerk lost their own letter");
    const own = await as("clerk").get(`/certificates?employeeId=${idOf.get(CLERK)}`);
    assert.ok((own.body.rows as { id: string }[]).some((row) => row.id === mine.body.id), "the clerk's own list lost its letter");
  });

  it("holds entities to the desk roles and to entities on record", async () => {
    const employee = await as("admin").patch(`/users/${userOf.get(ALPHA)}`, { entityIds: [aId] });
    assert.equal(employee.status, 400, JSON.stringify(employee.body));
    assert.equal(employee.body.message, "ENTITIES_NEED_DESK");
    const unknown = await as("admin").post("/users", {
      role: "HR",
      employeeId: idOf.get(SPARE),
      entityIds: ["no-such-entity"],
    });
    assert.equal(unknown.status, 404, JSON.stringify(unknown.body));
    assert.equal(unknown.body.message, "LEGAL_ENTITY_NOT_FOUND");
    assert.equal(await db.user.count({ where: { email: MAIL(SPARE) } }), 0, "a refused account was opened");
  });

  it("signs the desk out when its entities change, and the next ticket carries the new ones", async () => {
    const moved = await as("admin").patch(`/users/${userOf.get(CLERK)}`, { entityIds: [bId] });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.deepEqual(
      (moved.body.entities as { id: string }[]).map((one) => one.id),
      [bId],
    );
    const stale = await as("clerk").get(`/employees/${idOf.get(ALPHA)}`);
    assert.equal(stale.status, 401, "the ticket from before the change still reads entity A");
    const logged = await db.auditLog.count({ where: { action: "user.entities", subjectId: userOf.get(CLERK) } });
    assert.equal(logged, 1, "the change of entities left no audit row");

    await sleep(SECOND_MS);
    token.clerk = await signIn(http, MAIL(CLERK), PASSWORD);
    assert.equal((await as("clerk").get(`/employees/${idOf.get(BRAVO)}`)).status, 200);
    assert.equal((await as("clerk").get(`/employees/${idOf.get(ALPHA)}`)).status, 404);
  });

  it("shows a payslip to the entity that issued it and to the entity its person moved to", async () => {
    const policy = await db.payrollPolicy.findFirstOrThrow({ select: { id: true } });
    const period = await db.payrollPeriod.create({
      data: {
        legalEntityId: aId,
        year: YEAR,
        month: 2,
        startDate: new Date(Date.UTC(YEAR, 1, 1)),
        endDate: new Date(Date.UTC(YEAR, 1, 28)),
      },
    });
    const run = await db.payrollRun.create({ data: { periodId: period.id, kind: "REGULAR", state: "DONE" } });
    const slipOf = async (code: string) =>
      (
        await db.payslip.create({
          data: { runId: run.id, periodId: period.id, employeeId: idOf.get(code) ?? 0, policyId: policy.id, state: "ISSUED" },
        })
      ).id;
    const mover = await slipOf(ALPHA);
    const stayer = await slipOf(PURSER);
    await db.employee.update({ where: { id: idOf.get(ALPHA) }, data: { legalEntityId: bId, departmentId: bDepartment } });

    const slipsOf = async (who: "purser" | "clerk") =>
      ((await as(who).get(`/payslips?periodId=${period.id}`)).body.rows as { id: string }[]).map((row) => row.id).sort();
    assert.deepEqual(await slipsOf("purser"), [mover, stayer].sort(), "the issuing entity lost the slip of a person who moved on");
    assert.equal((await as("purser").get(`/payslips/${mover}`)).status, 200);
    assert.deepEqual(await slipsOf("clerk"), [mover], "the entity a person moved to misses their slip, or reads a stranger's");
    const stranger = await as("clerk").get(`/payslips/${stayer}`);
    assert.equal(stranger.status, 404);
    assert.equal(stranger.body.message, "PAYSLIP_NOT_FOUND");
  });
});
