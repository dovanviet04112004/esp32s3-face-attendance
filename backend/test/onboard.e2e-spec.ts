import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";

const HIRE = "E2EON01";
const FROM_NEW_YEAR = "E2EON02";
const BOSS = "E2EON03";
const GONE = "E2EON04";
const EMAIL = "e2eon@kiosk.local";
const SECOND_EMAIL = "e2eon2@kiosk.local";
const TITLE = "E2EON-JT";
const YEAR = 2039;
const LATE_START = `${YEAR}-10-01`;
const NEW_YEAR = `${YEAR}-01-01`;

interface Seeded {
  code: string;
  year: number;
  entitled: number;
}

interface Report {
  code: string;
  contractId: string | null;
  payId: string | null;
  leaveSeeded: Seeded[];
  checklist: { runId: string; tasks: number } | null;
  userId: string | null;
  skipped: string[];
}

describe("onboarding (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let token = "";
  let hireId = 0;
  let newYearId = 0;
  let bossId = 0;
  let goneId = 0;
  let titleId = "";
  let fullYear = 0;
  let paidTypeId = "";
  let paidCode = "";

  async function sweep(): Promise<void> {
    await db.user.deleteMany({ where: { email: { in: [EMAIL, SECOND_EMAIL] } } });
    await db.employee.deleteMany({ where: { code: { in: [HIRE, FROM_NEW_YEAR, GONE, BOSS] } } });
    await db.jobTitle.deleteMany({ where: { code: TITLE } });
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

    // A template bound to a job title outscores the general one, so the run
    // this suite reads is the one it wrote.
    const title = await db.jobTitle.create({
      data: {
        code: TITLE,
        name: "Chức danh thử nhận việc",
        checklists: {
          create: {
            kind: "ONBOARDING",
            name: "Nhận việc - thử",
            items: {
              create: [
                { ordinal: 1, title: "Cấp máy", owner: "HR", dueDays: 0 },
                { ordinal: 2, title: "Nộp hồ sơ", owner: "SELF", dueDays: 3 },
              ],
            },
          },
        },
      },
    });
    titleId = title.id;

    const boss = await db.employee.create({
      data: { code: BOSS, fullName: "Quản lý thử", active: true },
    });
    bossId = boss.id;
    const made = await db.employee.create({
      data: {
        code: HIRE,
        fullName: "Người mới",
        active: true,
        jobTitleId: titleId,
        managerId: bossId,
        personalEmail: EMAIL,
      },
    });
    hireId = made.id;
    const onNewYear = await db.employee.create({
      data: { code: FROM_NEW_YEAR, fullName: "Vào từ đầu năm", active: true },
    });
    newYearId = onNewYear.id;
    const left = await db.employee.create({
      data: {
        code: GONE,
        fullName: "Đã nghỉ",
        active: false,
        leaveDate: new Date(`${YEAR}-01-31T00:00:00.000Z`),
      },
    });
    goneId = left.id;

    // Onboarding seeds a balance for every active type, so the claims below
    // name one rather than taking whichever row the table hands back.
    const paid = await db.leaveType.findFirstOrThrow({
      where: { active: true, paid: true, daysPerYear: { gt: 0 } },
      orderBy: { code: "asc" },
    });
    paidTypeId = paid.id;
    paidCode = paid.code;
    fullYear = Number(paid.daysPerYear);
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("writes the contract, the pay, the leave, the checklist and the login at once", async () => {
    const res = await request(http)
      .post(`/employees/${hireId}/onboard`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        contract: { kind: "PROBATION", startDate: LATE_START, probationEnd: `${YEAR}-12-31` },
        pay: { baseSalary: 15_000_000, insuranceSalary: 15_000_000 },
      });
    assert.equal(res.status, 201);
    const report = res.body as Report;
    assert.deepEqual(report.skipped, [], "a fresh record skipped something");
    assert.ok(report.contractId, "no contract was written");
    assert.ok(report.payId, "no pay was written");
    assert.ok(report.userId, "no login was opened");
    assert.equal(report.checklist?.tasks, 2, "the checklist did not come from this suite's template");

    const contract = await db.employmentContract.findUniqueOrThrow({
      where: { id: report.contractId as string },
    });
    assert.equal(contract.state, "DRAFT", "a contract nobody has signed went out active");
    assert.equal(contract.signedAt, null);

    const pay = await db.compensationRecord.findUniqueOrThrow({
      where: { id: report.payId as string },
    });
    assert.equal(pay.reason, "HIRE");

    const mine = await db.checklistTask.findMany({
      where: { runId: report.checklist?.runId },
      orderBy: { ordinal: "asc" },
    });
    assert.deepEqual(
      mine.map((one) => one.ownerId),
      [null, hireId],
      "the task written for the hire is not owned by them",
    );
    assert.equal(
      mine[1].dueOn.toISOString().slice(0, 10),
      `${YEAR}-10-04`,
      "a task due three days in did not land three days in",
    );
  });

  it("gives a part of the year's leave to somebody joining in October", async () => {
    const balance = await db.leaveBalance.findFirstOrThrow({
      where: { employeeId: hireId, year: YEAR, leaveTypeId: paidTypeId },
    });
    const days = Number(balance.entitled);
    assert.ok(days > 0, "an October hire earned no leave at all");
    assert.ok(days < fullYear, `October earned ${days} of a ${fullYear} day year`);
    assert.equal(days * 2, Math.round(days * 2), "leave landed off a half day");
  });

  it("gives the whole year to somebody joining on the first of January", async () => {
    const res = await request(http)
      .post(`/employees/${newYearId}/onboard`)
      .set("Authorization", `Bearer ${token}`)
      .send({ contract: { kind: "INDEFINITE", startDate: NEW_YEAR }, startChecklist: false });
    assert.equal(res.status, 201);
    const seeded = (res.body as Report).leaveSeeded;
    const paid = seeded.find((one) => one.year === YEAR && one.code === paidCode);
    assert.equal(Number(paid?.entitled), fullYear, "a full year of service earned less than a year");
  });

  it("writes nothing a second time, and says what it left alone", async () => {
    const before = await counts(db, hireId);
    const res = await request(http)
      .post(`/employees/${hireId}/onboard`)
      .set("Authorization", `Bearer ${token}`)
      .send({
        contract: { kind: "PROBATION", startDate: LATE_START },
        pay: { baseSalary: 15_000_000, insuranceSalary: 15_000_000 },
      });
    assert.equal(res.status, 201);
    const report = res.body as Report;
    assert.deepEqual(report.leaveSeeded, [], "a second pass handed out leave again");
    assert.equal(report.checklist, null);
    assert.equal(report.userId, null);
    assert.ok(report.skipped.includes("CONTRACT_EXISTS"));
    assert.ok(report.skipped.includes("PAY_EXISTS"));
    assert.ok(report.skipped.includes("LOGIN_EXISTS"));
    assert.deepEqual(await counts(db, hireId), before, "a second pass doubled something");
  });

  it("refuses a record that has already left", async () => {
    const res = await request(http)
      .post(`/employees/${goneId}/onboard`)
      .set("Authorization", `Bearer ${token}`)
      .send({ contract: { kind: "INDEFINITE", startDate: LATE_START } });
    assert.equal(res.status, 409);
  });
});

async function counts(db: PrismaService, employeeId: number): Promise<number[]> {
  return Promise.all([
    db.employmentContract.count({ where: { employeeId } }),
    db.compensationRecord.count({ where: { employeeId } }),
    db.leaveBalance.count({ where: { employeeId } }),
    db.checklistRun.count({ where: { employeeId } }),
    db.user.count({ where: { employeeId } }),
  ]);
}
