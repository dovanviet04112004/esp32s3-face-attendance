import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { hashPassword } from "../src/modules/auth/password.js";

const CODE = "E2ESD01";
const EMAIL = "e2e-self-decision@kiosk.local";
const PASSWORD = "e2e-self-decision-password";
const PAY_YEAR = 1998;

describe("nobody decides their own request (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let token = "";
  let employeeId = 0;
  let templateId = "";

  function post(path: string, body: object): request.Test {
    return request(http).post(path).set("Authorization", `Bearer ${token}`).send(body);
  }

  function refusedAsSelf(res: request.Response, what: string): void {
    assert.equal(res.status, 403, `${what}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.message, "SELF_DECISION", what);
  }

  async function sweep(): Promise<void> {
    await db.payrollPeriod.deleteMany({ where: { year: PAY_YEAR } });
    await db.user.deleteMany({ where: { email: EMAIL } });
    await db.employee.deleteMany({ where: { code: CODE } });
    if (templateId) {
      await db.checklistTemplate.deleteMany({ where: { id: templateId } });
    }
  }

  before(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    http = app.getHttpServer();
    db = app.get(PrismaService);
    await sweep();

    const template = await db.employee.findFirstOrThrow({
      where: { active: true, legalEntityId: { not: null } },
    });
    const person = await db.employee.create({
      data: { code: CODE, fullName: "Tự duyệt thử", active: true, legalEntityId: template.legalEntityId },
    });
    employeeId = person.id;
    // PAYROLL writes pay, answers claims and reads every checklist, so one login reaches all four doors.
    await db.user.create({
      data: { email: EMAIL, role: "PAYROLL", employeeId, passwordHash: await hashPassword(PASSWORD) },
    });
    const signed = await request(http).post("/auth/login").send({ email: EMAIL, password: PASSWORD });
    assert.equal(signed.status, 200, "the payroll clerk could not sign in");
    token = signed.body.accessToken as string;
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("will not let anyone decide their own leave request", async () => {
    const own = await db.request.create({
      data: {
        employeeId,
        kind: "ATTENDANCE_FIX",
        state: "PENDING",
        fromDate: new Date("1998-03-02"),
        toDate: new Date("1998-03-02"),
        reason: "Quên quẹt thẻ",
      },
    });
    refusedAsSelf(await post(`/requests/${own.id}/decide`, { approve: true }), "leave");
    assert.equal((await db.request.findUniqueOrThrow({ where: { id: own.id } })).state, "PENDING");
  });

  it("will not let payroll answer its own claim about its own payslip", async () => {
    const policy = await db.payrollPolicy.findFirstOrThrow();
    const period = await db.payrollPeriod.create({
      data: { year: PAY_YEAR, month: 1, startDate: new Date("1998-01-01"), endDate: new Date("1998-01-31") },
    });
    const run = await db.payrollRun.create({ data: { periodId: period.id } });
    const slip = await db.payslip.create({
      data: { runId: run.id, periodId: period.id, employeeId, policyId: policy.id },
    });
    const claim = await db.payslipDispute.create({
      data: { payslipId: slip.id, employeeId, claim: "Thiếu phụ cấp", dueAt: new Date(Date.now() + 86_400_000) },
    });
    refusedAsSelf(
      await post(`/payslip-disputes/${claim.id}/answer`, { outcome: "UPHELD", answer: "Đồng ý", amount: 5_000_000 }),
      "dispute",
    );
  });

  it("will not let anyone approve a dependent who lowers their own tax", async () => {
    const own = await db.dependent.create({
      data: { employeeId, fullName: "Con thử", relation: "CHILD", fromMonth: new Date("1998-01-01") },
    });
    refusedAsSelf(await post(`/dependents/${own.id}/decide`, { approve: true }), "dependent");
  });

  it("will not let the person on a checklist tick a task the desk owns", async () => {
    const made = await db.checklistTemplate.create({ data: { kind: "ONBOARDING", name: "Tự duyệt thử" } });
    templateId = made.id;
    const run = await db.checklistRun.create({
      data: { employeeId, templateId, kind: "ONBOARDING", anchorDate: new Date("1998-01-05") },
    });
    const desk = await db.checklistTask.create({
      data: { runId: run.id, ordinal: 1, title: "Cấp máy tính", ownerRole: "HR", dueOn: new Date("1998-01-06") },
    });
    const mine = await db.checklistTask.create({
      data: { runId: run.id, ordinal: 2, title: "Đọc nội quy", ownerRole: "SELF", dueOn: new Date("1998-01-06") },
    });
    refusedAsSelf(await post(`/checklist-tasks/${desk.id}/finish`, {}), "checklist");
    assert.equal((await post(`/checklist-tasks/${mine.id}/finish`, {})).status, 201, "a person could not tick their own task");
  });
});
