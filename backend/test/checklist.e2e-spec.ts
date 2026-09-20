import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";

const BOSS = "E2ECL01";
const STARTER = "E2ECL02";
const MADE_CODES = [BOSS, STARTER];
const TITLE = "E2ECL-TITLE";
const PLAIN = "E2ECL mọi người";
const EXACT = "E2ECL đúng chức danh";
const FIRST_DAY = "2026-10-05";

interface Task {
  id: string;
  ordinal: number;
  title: string;
  ownerRole: string;
  ownerId: number | null;
  dueOn: string;
  doneAt: string | null;
}

interface Run {
  template: { name: string };
  tasks: Task[];
}

describe("onboarding checklist (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let token = "";
  const idOf = new Map<string, number>();

  // People first: a template with a run against it is kept on purpose, so the
  // runs leave with their employee and only then can the template go.
  async function sweep(): Promise<void> {
    await db.employee.deleteMany({ where: { code: { in: MADE_CODES } } });
    await db.checklistTemplate.deleteMany({ where: { name: { in: [PLAIN, EXACT] } } });
    await db.jobTitle.deleteMany({ where: { code: TITLE } });
  }

  async function post(path: string, body: object): Promise<request.Response> {
    return request(http).post(path).set("Authorization", `Bearer ${token}`).send(body);
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

    const title = await db.jobTitle.create({ data: { code: TITLE, name: "Chức danh thử" } });
    const boss = await db.employee.create({
      data: { code: BOSS, fullName: "Cấp trên", active: true },
    });
    idOf.set(BOSS, boss.id);
    const starter = await db.employee.create({
      data: {
        code: STARTER,
        fullName: "Người mới",
        active: true,
        jobTitleId: title.id,
        managerId: boss.id,
      },
    });
    idOf.set(STARTER, starter.id);

    await post("/checklist-templates", {
      kind: "ONBOARDING",
      name: PLAIN,
      items: [{ title: "Ký hợp đồng", owner: "HR", dueDays: 0 }],
    });
    await post("/checklist-templates", {
      kind: "ONBOARDING",
      name: EXACT,
      jobTitleId: title.id,
      items: [
        { title: "Ký hợp đồng", owner: "HR", dueDays: 0 },
        { title: "Cấp máy và tài khoản", owner: "MANAGER", dueDays: 1 },
        { title: "Đọc nội quy", owner: "SELF", dueDays: 7 },
      ],
    });
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("picks the template written for the job title over the general one", async () => {
    const res = await post("/checklists", {
      employeeId: idOf.get(STARTER),
      kind: "ONBOARDING",
      anchorDate: FIRST_DAY,
    });
    assert.equal(res.status, 201);
    const run = res.body as Run;
    assert.equal(run.template.name, EXACT);
    assert.equal(run.tasks.length, 3);
  });

  it("gives each task an owner and a date counted from the first day", async () => {
    const res = await request(http)
      .get(`/employees/${idOf.get(STARTER) as number}/checklist?kind=ONBOARDING`)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    const tasks = (res.body as Run).tasks;
    assert.deepEqual(
      tasks.map((one) => [one.ownerRole, one.ownerId, one.dueOn.slice(0, 10)]),
      [
        ["HR", null, FIRST_DAY],
        ["MANAGER", idOf.get(BOSS), "2026-10-06"],
        ["SELF", idOf.get(STARTER), "2026-10-12"],
      ],
      "HR work belongs to a desk, so its owner stays empty",
    );
  });

  it("refuses a second run of the same kind for the same person", async () => {
    const res = await post("/checklists", {
      employeeId: idOf.get(STARTER),
      kind: "ONBOARDING",
      anchorDate: FIRST_DAY,
    });
    assert.equal(res.status, 409);
    assert.equal(res.body.message, "CHECKLIST_ALREADY_STARTED");
  });

  it("shows the open work and takes one off the list when it is finished", async () => {
    const before = await request(http)
      .get("/checklists/open")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(before.status, 200);
    const mine = (before.body as Task[]).filter((one) => one.title === "Đọc nội quy");
    assert.equal(mine.length, 1);

    const done = await post(`/checklist-tasks/${mine[0]?.id as string}/finish`, { note: "e2e" });
    assert.equal(done.status, 201);
    assert.ok(done.body.doneAt, "finishing has to stamp when");

    const again = await post(`/checklist-tasks/${mine[0]?.id as string}/finish`, {});
    assert.equal(again.status, 409, "finishing twice would lose who finished it first");
  });

  it("edits to a template leave a run already handed out alone", async () => {
    const template = await db.checklistTemplate.findFirstOrThrow({ where: { name: EXACT } });
    await db.checklistTemplateItem.deleteMany({ where: { templateId: template.id } });

    const res = await request(http)
      .get(`/employees/${idOf.get(STARTER) as number}/checklist?kind=ONBOARDING`)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.equal((res.body as Run).tasks.length, 3, "work already given out does not vanish");
  });
});
