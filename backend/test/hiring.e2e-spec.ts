import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { parseCsv } from "../src/modules/employees/import.js";

const PREFIX = "E2EHIR";
const DOMAIN = "@e2e-hiring.local";
const OTHER_ENTITY = `${PREFIX}-LE`;
const ACCOUNTS = { admin: "admin@kiosk.local", hr: "hr@kiosk.local", payroll: "payroll@kiosk.local" };
const DAY_MS = 86_400_000;

type Who = keyof typeof ACCOUNTS;

describe("hiring and the employee record (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  const token = {} as Record<Who, string>;
  let department = { id: "", legalEntityId: "" };

  async function sweep(): Promise<void> {
    await db.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
    await db.employee.updateMany({ where: { code: { startsWith: PREFIX } }, data: { managerId: null } });
    await db.employee.deleteMany({ where: { code: { startsWith: PREFIX } } });
    await db.legalEntity.deleteMany({ where: { code: OTHER_ENTITY } });
  }

  function as(who: Who, method: "get" | "post" | "patch" | "delete", path: string): request.Test {
    return request(http)[method](path).set("Authorization", `Bearer ${token[who]}`);
  }

  async function hire(code: string, extra: Record<string, unknown> = {}): Promise<number> {
    const res = await as("hr", "post", "/employees").send({ code: `${PREFIX}${code}`, fullName: `Người ${code}`, ...extra });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.id as number;
  }

  before(async () => {
    const password = validateEnv().SEED_ADMIN_PASSWORD ?? "";
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    http = app.getHttpServer();
    db = app.get(PrismaService);
    await sweep();
    for (const [who, email] of Object.entries(ACCOUNTS)) {
      const res = await request(http).post("/auth/login").send({ email, password });
      assert.equal(res.status, 200, `${who} could not sign in`);
      token[who as Who] = res.body.accessToken;
    }
    const entity = await db.legalEntity.findUniqueOrThrow({ where: { code: "DEFAULT" } });
    department = await db.department.findFirstOrThrow({
      where: { legalEntityId: entity.id, code: "PB0001" },
      select: { id: true, legalEntityId: true },
    });
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("takes the legal entity from the department when none is named", async () => {
    const id = await hire("01", { departmentId: department.id });
    const held = await db.employee.findUniqueOrThrow({ where: { id } });
    assert.equal(held.legalEntityId, department.legalEntityId);
  });

  it("refuses a department that belongs to another legal entity", async () => {
    const other = await db.legalEntity.create({ data: { code: OTHER_ENTITY, name: "Pháp nhân thử" } });
    const res = await as("hr", "post", "/employees").send({
      code: `${PREFIX}02`,
      fullName: "Sai pháp nhân",
      legalEntityId: other.id,
      departmentId: department.id,
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.message, "DEPARTMENT_OTHER_ENTITY");
  });

  it("clears the manager and the department with an explicit null", async () => {
    const boss = await hire("03");
    const id = await hire("04", { departmentId: department.id, managerId: boss });
    const res = await as("hr", "patch", `/employees/${id}`).send({ managerId: null, departmentId: null });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.managerId, null);
    assert.equal(res.body.departmentId, null);
  });

  it("refuses a manager who is gone or never was", async () => {
    const id = await hire("05");
    const left = await db.employee.create({
      data: { code: `${PREFIX}06`, fullName: "Đã nghỉ", active: false, leaveDate: new Date() },
    });
    const gone = await as("hr", "patch", `/employees/${id}`).send({ managerId: left.id });
    assert.equal(gone.status, 409);
    assert.equal(gone.body.message, "MANAGER_HAS_LEFT");
    const ghost = await as("hr", "patch", `/employees/${id}`).send({ managerId: 999_999_999 });
    assert.equal(ghost.status, 404);
    assert.equal(ghost.body.message, "MANAGER_NOT_FOUND");
  });

  it("opens a login, mails it again, and says why when it cannot", async () => {
    const bare = await hire("10");
    const none = await as("hr", "post", `/employees/${bare}/login`);
    assert.equal(none.status, 400);
    assert.equal(none.body.message, "NO_EMAIL");
    const state = await as("hr", "get", `/employees/${bare}/login`);
    assert.equal(state.status, 200);
    assert.deepEqual([state.body.state, state.body.hasEmail], ["none", false]);

    const id = await hire("11", { personalEmail: `hire11${DOMAIN}` });
    const opened = await as("hr", "post", `/employees/${id}/login`);
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
    assert.equal(opened.body.state, "opened");
    const waiting = await as("hr", "get", `/employees/${id}/login`);
    assert.deepEqual([waiting.body.state, waiting.body.email], ["pending", `hire11${DOMAIN}`]);

    const again = await as("hr", "post", `/employees/${id}/login`);
    assert.equal(again.body.state, "resent");
    const login = await db.user.findUniqueOrThrow({ where: { employeeId: id } });
    assert.equal(await db.passwordSetup.count({ where: { userId: login.id } }), 2, "resending minted no new link");

    const locked = await as("admin", "patch", `/users/${login.id}`).send({ active: false });
    assert.equal(locked.status, 200);
    const refused = await as("hr", "post", `/employees/${id}/login`);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.message, "ACCOUNT_LOCKED");
    assert.equal((await as("hr", "get", `/employees/${id}/login`)).body.state, "locked");

    const clash = await hire("12", { personalEmail: ACCOUNTS.hr });
    const taken = await as("hr", "post", `/employees/${clash}/login`);
    assert.equal(taken.status, 409);
    assert.equal(taken.body.message, "EMAIL_TAKEN");

    const leaver = await hire("13", { personalEmail: `hire13${DOMAIN}` });
    const off = await as("hr", "post", `/employees/${leaver}/offboard`).send({ leaveDate: "2026-01-31" });
    assert.equal(off.status, 201);
    const late = await as("hr", "post", `/employees/${leaver}/login`);
    assert.equal(late.status, 409);
    assert.equal(late.body.message, "EMPLOYEE_HAS_LEFT");
  });

  it("counts the people still working and those who left under one search", async () => {
    const res = await as("hr", "get", `/employees/counts?search=${PREFIX}`);
    assert.equal(res.status, 200);
    const working = await db.employee.count({ where: { code: { startsWith: PREFIX }, active: true } });
    const left = await db.employee.count({ where: { code: { startsWith: PREFIX }, active: false } });
    assert.deepEqual(res.body, { active: working, left });
  });

  it("exports what the list filters show, and payroll may export", async () => {
    const res = await as("payroll", "get", `/employees/export?search=${PREFIX}&active=true&format=csv`);
    assert.equal(res.status, 200, "payroll could not export the directory");
    const lines = parseCsv(res.text).slice(1).filter((cells) => cells.length > 1);
    assert.ok(lines.length > 0);
    assert.ok(lines.every((cells) => (cells[0] ?? "").startsWith(PREFIX)), "the export ignored the search");
    assert.ok(!lines.some((cells) => cells[0] === `${PREFIX}06`), "the export ignored the status filter");
  });

  it("lists the people whose contract or probation ends soon, soonest first", async () => {
    const inDays = (count: number) => new Date(Date.now() + count * DAY_MS);
    const deal = async (code: string, ends: { endDate?: Date; probationEnd?: Date }, active = true) => {
      const made = await db.employee.create({
        data: { code: `${PREFIX}${code}`, fullName: `Sắp hết ${code}`, active, ...(active ? {} : { leaveDate: new Date() }) },
      });
      await db.employmentContract.create({
        data: { employeeId: made.id, kind: "FIXED_TERM", state: "ACTIVE", startDate: inDays(-300), ...ends },
      });
      return made.id;
    };
    const soon = await deal("20", { endDate: inDays(10) });
    const later = await deal("21", { endDate: inDays(60) });
    const trial = await deal("22", { probationEnd: inDays(5) });
    await deal("23", { endDate: inDays(3) }, false);

    const read = async (query: string) => {
      const res = await as("hr", "get", `/employees?search=${PREFIX}&${query}`);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      return res.body as { rows: { id: number; endsOn: string }[]; total: number; next: string | null };
    };
    const month = await read("ending=contract");
    assert.deepEqual(month.rows.map((row) => row.id), [soon], "the window kept someone outside it or someone who left");
    assert.equal(month.rows[0]?.endsOn, inDays(10).toISOString().slice(0, 10));

    const quarter = await read("ending=contract&within=90");
    assert.deepEqual(quarter.rows.map((row) => row.id), [soon, later], "the soonest ending is not first");
    const first = await read("ending=contract&within=90&take=1");
    const second = await read(`ending=contract&within=90&take=1&cursor=${encodeURIComponent(first.next ?? "")}`);
    assert.deepEqual([...first.rows, ...second.rows].map((row) => row.id), [soon, later], "paging broke the order");

    const probation = await read("ending=probation");
    assert.deepEqual(probation.rows.map((row) => row.id), [trial]);
    const wrong = await as("hr", "get", "/employees?ending=retirement");
    assert.equal(wrong.status, 400);
  });

  it("hands out a template whose example line the import accepts", async () => {
    const res = await as("hr", "get", "/employees/import/template?format=csv");
    assert.equal(res.status, 200);
    const grid = parseCsv(res.text).filter((cells) => cells.some((cell) => cell !== ""));
    assert.equal(grid.length, 2, "the template carries no example line");
    const check = await as("hr", "post", "/employees/import").send({ csv: res.text });
    assert.equal(check.status, 201);
    assert.deepEqual(check.body.faults, [], "the example line fails the import it documents");
  });
});
