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
import { dayAsDate, localDay } from "../src/modules/timesheet/local-day.js";
import { paidLeaveType } from "./fixtures.js";

const HIRE = "E2EON01";
const FROM_NEW_YEAR = "E2EON02";
const BOSS = "E2EON03";
const GONE = "E2EON04";
const CLERK = "E2EON05";
const PAID = "E2EON06";
const EMAIL = "e2eon@kiosk.local";
const SECOND_EMAIL = "e2eon2@kiosk.local";
const CLERK_EMAIL = "e2eon-clerk@kiosk.local";
const CLERK_PASSWORD = "kiosk-e2e-password";
const TITLE = "E2EON-JT";
const YEAR = 2039;
const LATE_START = `${YEAR}-10-01`;
const NEW_YEAR = `${YEAR}-01-01`;
const FIRST_PAY = 15_000_000;
const RAISED_PAY = 90_000_000;

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
  let clerkToken = "";
  let hireId = 0;
  let newYearId = 0;
  let bossId = 0;
  let goneId = 0;
  let clerkId = 0;
  let paidId = 0;
  let titleId = "";
  let fullYear = 0;
  let paidTypeId = "";
  let paidCode = "";

  async function sweep(): Promise<void> {
    await db.user.deleteMany({ where: { email: { in: [EMAIL, SECOND_EMAIL, CLERK_EMAIL] } } });
    await db.employee.deleteMany({ where: { code: { in: [HIRE, FROM_NEW_YEAR, GONE, BOSS, CLERK, PAID] } } });
    await db.jobTitle.deleteMany({ where: { code: TITLE } });
    await db.payrollPeriod.deleteMany({ where: { legalEntityId: null, year: YEAR, month: 10 } });
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
    const paid = await paidLeaveType(db);
    paidTypeId = paid.id;
    paidCode = paid.code;
    fullYear = Number(paid.daysPerYear);

    const entity = await db.legalEntity.findUniqueOrThrow({ where: { code: "DEFAULT" } });
    clerkId = (
      await db.employee.create({
        data: {
          code: CLERK,
          fullName: "Nhân sự tự nhận việc",
          active: true,
          legalEntityId: entity.id,
          login: { create: { email: CLERK_EMAIL, passwordHash: await hashPassword(CLERK_PASSWORD), role: "HR" } },
        },
      })
    ).id;
    const clerk = await request(http).post("/auth/login").send({ email: CLERK_EMAIL, password: CLERK_PASSWORD });
    assert.equal(clerk.status, 200, "the HR clerk could not sign in");
    clerkToken = clerk.body.accessToken;
    paidId = (
      await db.employee.create({
        data: {
          code: PAID,
          fullName: "Đã có lương",
          active: true,
          legalEntityId: entity.id,
          compensation: {
            create: { effectiveFrom: new Date(NEW_YEAR), baseSalary: FIRST_PAY, insuranceSalary: FIRST_PAY, reason: "HIRE" },
          },
        },
      })
    ).id;
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

  // A probation that ran out undecided is already a hire (KEHOACH 9.18), so
  // only the ones still ahead are a decision to make.
  it("lists a probation ending within the month and leaves out one already over", async () => {
    const dayMs = 86_400_000;
    const today = dayAsDate(localDay(new Date(), validateEnv().APP_TIMEZONE)).getTime();
    const day = (offset: number) => today + offset * dayMs;
    const [ahead, over] = await Promise.all(
      [10, -10].map((offset) =>
        db.employmentContract.create({
          data: {
            employeeId: bossId,
            kind: "PROBATION",
            state: "ACTIVE",
            startDate: new Date(day(offset - 60)),
            probationEnd: new Date(day(offset)),
          },
        }),
      ),
    );
    const res = await request(http).get("/reports/attention").set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    const listed = res.body.probationEnding.rows.map((row: { contractId: string }) => row.contractId);
    assert.ok(listed.includes(ahead.id), "a probation ending in ten days is missing");
    assert.ok(!listed.includes(over.id), "a probation over ten days ago is still listed");
    const mine = res.body.probationEnding.rows.find((row: { contractId: string }) => row.contractId === ahead.id);
    assert.equal(mine.daysLeft, 10);
  });

  it("writes the first pay through the pay door, with its from and to on the trail", async () => {
    const line = await db.auditLog.findFirst({
      where: { subjectType: "employee", subjectId: String(hireId), action: "pay.create" },
    });
    assert.ok(line, "the first pay of a hire left no pay line on the trail");
    assert.deepEqual(
      [(line.meta as { from?: unknown }).from, (line.meta as { to?: unknown }).to],
      [null, String(FIRST_PAY)],
    );
  });

  it("will not let anyone take themselves on, pay included", async () => {
    const res = await request(http)
      .post(`/employees/${clerkId}/onboard`)
      .set("Authorization", `Bearer ${clerkToken}`)
      .send({ contract: { kind: "INDEFINITE", startDate: LATE_START }, pay: { baseSalary: RAISED_PAY, insuranceSalary: RAISED_PAY } });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.equal(res.body.message, "SELF_DECISION");
    assert.deepEqual(await counts(db, clerkId), [0, 0, 0, 0, 1], "a refused onboarding wrote something");
  });

  it("keeps the pay somebody already has, whatever start date the onboarding names", async () => {
    const res = await request(http)
      .post(`/employees/${paidId}/onboard`)
      .set("Authorization", `Bearer ${clerkToken}`)
      .send({
        contract: { kind: "INDEFINITE", startDate: `${YEAR}-11-01` },
        pay: { baseSalary: RAISED_PAY, insuranceSalary: RAISED_PAY },
        startChecklist: false,
        openLogin: false,
      });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.ok((res.body as Report).skipped.includes("PAY_EXISTS"), "an onboarding wrote a second pay record");
    const pay = await db.compensationRecord.findMany({ where: { employeeId: paidId } });
    assert.deepEqual(
      pay.map((one) => one.baseSalary.toFixed(0)),
      [String(FIRST_PAY)],
      "an onboarding raised the pay of somebody already paid",
    );
  });

  it("puts pay that takes effect in a period on that period's checklist", async () => {
    const period = await db.payrollPeriod.create({
      data: { year: YEAR, month: 10, startDate: new Date(LATE_START), endDate: new Date(`${YEAR}-10-31`) },
    });
    const res = await request(http)
      .get(`/payroll-periods/${period.id}/checklist`)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    const item = (res.body as { code: string; count: number }[]).find((one) => one.code === "PAY_CHANGES");
    assert.ok(item, "the checklist has no line for pay that changes in the period");
    assert.ok(item.count >= 1, "the hire's first pay from the first of October is not counted");
  });

  it("refuses the first pay a file would give the person importing it", async () => {
    const res = await request(http)
      .post("/employees/import")
      .set("Authorization", `Bearer ${clerkToken}`)
      .send({ csv: ["code,fullName,baseSalary,insuranceSalary", `${CLERK},Nhân sự tự nhận việc,${RAISED_PAY},${RAISED_PAY}`].join("\r\n") });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const faults = (res.body as { faults: { column: string; code: string }[] }).faults;
    assert.deepEqual(
      faults.map((one) => [one.column, one.code]),
      [["baseSalary", "SELF_DECISION"]],
      "a file let its importer set their own pay",
    );
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
