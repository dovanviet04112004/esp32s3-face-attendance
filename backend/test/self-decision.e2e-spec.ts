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
const DESK_CODE = "E2ESD02";
const OTHER_CODE = "E2ESD03";
const EMAIL = "e2e-self-decision@kiosk.local";
const DESK_EMAIL = "e2e-self-decision-desk@kiosk.local";
const LOOSE_EMAIL = "e2e-self-decision-loose@kiosk.local";
const PASSWORD = "e2e-self-decision-password";
const PAY_YEAR = 1998;
// Past every day another suite closes due records through, so no other run closes these.
const FAR_YEAR = 2046;
const SCHEDULED = `${FAR_YEAR}-06-30`;

describe("nobody decides their own request (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let token = "";
  let deskToken = "";
  let looseToken = "";
  let employeeId = 0;
  let deskId = 0;
  let otherId = 0;
  let templateId = "";

  function post(path: string, body: object): request.Test {
    return request(http).post(path).set("Authorization", `Bearer ${token}`).send(body);
  }

  function by(bearer: string) {
    const signed = (call: request.Test) => call.set("Authorization", `Bearer ${bearer}`);
    return {
      get: (path: string) => signed(request(http).get(path)),
      post: (path: string, body: object = {}) => signed(request(http).post(path)).send(body),
      patch: (path: string, body: object) => signed(request(http).patch(path)).send(body),
      delete: (path: string) => signed(request(http).delete(path)),
    };
  }

  function refusedAsSelf(res: request.Response, what: string): void {
    assert.equal(res.status, 403, `${what}: ${JSON.stringify(res.body)}`);
    assert.equal(res.body.message, "SELF_DECISION", what);
  }

  async function signIn(email: string): Promise<string> {
    const signed = await request(http).post("/auth/login").send({ email, password: PASSWORD });
    assert.equal(signed.status, 200, `${email} could not sign in`);
    return signed.body.accessToken as string;
  }

  async function sweep(): Promise<void> {
    await db.payrollPeriod.deleteMany({ where: { year: { in: [PAY_YEAR, FAR_YEAR] } } });
    await db.user.deleteMany({ where: { email: { in: [EMAIL, DESK_EMAIL, LOOSE_EMAIL] } } });
    await db.employee.deleteMany({ where: { code: { in: [CODE, DESK_CODE, OTHER_CODE] } } });
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
    token = await signIn(EMAIL);

    const desk = await db.employee.create({
      data: {
        code: DESK_CODE,
        fullName: "Nhân sự tự duyệt thử",
        active: true,
        leaveDate: new Date(SCHEDULED),
        legalEntityId: template.legalEntityId,
      },
    });
    deskId = desk.id;
    otherId = (
      await db.employee.create({
        data: { code: OTHER_CODE, fullName: "Người khác thử", active: true, legalEntityId: template.legalEntityId },
      })
    ).id;
    const passwordHash = await hashPassword(PASSWORD);
    await db.user.createMany({
      data: [
        { email: DESK_EMAIL, role: "HR", employeeId: deskId, passwordHash },
        { email: LOOSE_EMAIL, role: "HR", passwordHash },
      ],
    });
    deskToken = await signIn(DESK_EMAIL);
    looseToken = await signIn(LOOSE_EMAIL);
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

  it("will not let payroll load the settlement of its own leaving", async () => {
    await db.employee.update({ where: { id: employeeId }, data: { leaveDate: new Date(`${FAR_YEAR}-03-20`) } });
    const period = await db.payrollPeriod.create({
      data: { year: FAR_YEAR, month: 3, startDate: new Date(`${FAR_YEAR}-03-01`), endDate: new Date(`${FAR_YEAR}-03-31`) },
    });
    const run = await db.payrollRun.create({ data: { periodId: period.id, kind: "FINAL_SETTLEMENT" } });
    refusedAsSelf(
      await post(`/payroll-runs/${run.id}/settlement`, { items: [{ employeeId, kind: "SEVERANCE", amount: 90_000_000 }] }),
      "settlement",
    );
    assert.equal(await db.settlementItem.count({ where: { runId: run.id } }), 0, "a refused severance was loaded");
  });

  it("will not let anyone move or call off their own leaving", async () => {
    const desk = by(deskToken);
    refusedAsSelf(await desk.patch(`/employees/${deskId}/offboard`, { leaveDate: `${FAR_YEAR}-12-31` }), "moved leaving");
    refusedAsSelf(await desk.delete(`/employees/${deskId}/offboard`), "cancelled leaving");
    const held = await db.employee.findUniqueOrThrow({ where: { id: deskId } });
    assert.equal(held.leaveDate?.toISOString().slice(0, 10), SCHEDULED, "the own leaving date moved");
  });

  it("will not let anyone write or sign their own contract", async () => {
    const desk = by(deskToken);
    refusedAsSelf(
      await desk.post("/contracts", { employeeId: deskId, kind: "INDEFINITE", startDate: `${FAR_YEAR}-01-01` }),
      "written contract",
    );
    assert.equal(await db.employmentContract.count({ where: { employeeId: deskId } }), 0, "a refused contract was written");
    const draft = await db.employmentContract.create({
      data: { employeeId: deskId, kind: "INDEFINITE", startDate: new Date(`${FAR_YEAR}-01-01`) },
    });
    refusedAsSelf(await desk.patch(`/contracts/${draft.id}`, { state: "ACTIVE" }), "signed contract");
    assert.equal((await db.employmentContract.findUniqueOrThrow({ where: { id: draft.id } })).state, "DRAFT");
  });

  it("refuses a desk account with no record behind it at every door that has a self rule", async () => {
    const loose = by(looseToken);
    assert.equal((await loose.get("/employees?take=1")).status, 200, "an unlinked account lost its sign-in");
    const deskless = (res: request.Response, what: string) => {
      assert.equal(res.status, 403, `${what}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.message, "DESK_NEEDS_EMPLOYEE", what);
    };
    deskless(
      await loose.post("/compensation", {
        employeeId: otherId,
        effectiveFrom: `${FAR_YEAR}-01-01`,
        baseSalary: 90_000_000,
        insuranceSalary: 90_000_000,
        reason: "ADJUSTMENT",
      }),
      "pay",
    );
    const waiting = await db.request.create({
      data: {
        employeeId: otherId,
        kind: "OVERTIME",
        state: "PENDING",
        fromDate: new Date("1998-03-03"),
        toDate: new Date("1998-03-03"),
        minutes: 60,
        reason: "Tăng ca thử",
      },
    });
    deskless(await loose.post(`/requests/${waiting.id}/decide`, { approve: true }), "request");
    deskless(
      await loose.post("/contracts", { employeeId: otherId, kind: "INDEFINITE", startDate: `${FAR_YEAR}-01-01` }),
      "contract",
    );
    assert.equal(await db.compensationRecord.count({ where: { employeeId: otherId } }), 0, "a refused pay record was written");
    assert.equal((await db.request.findUniqueOrThrow({ where: { id: waiting.id } })).state, "PENDING");
  });
});
