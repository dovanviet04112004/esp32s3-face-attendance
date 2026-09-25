import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";

const TITLE = "E2ECAT-KTV";
const ENTITY = "E2ECAT-PN";
const OTHER_ENTITY = "E2ECAT-PN2";
const TOP = "E2ECAT-TOP";
const CHILD = "E2ECAT-CHILD";
const ELSEWHERE = "E2ECAT-ELSE";
const LUNCH = "E2ECAT-LUNCH";
const PHONE = "E2ECAT-PHONE";
const DUTY = "E2ECAT-DUTY";
const WORKER = "NV9171C";
const HR_CODE = "NV0010";
const D02_ON = "2026-06-01";
const PAY_FROM = "2026-01-01";
const BOM = "﻿";
const LUNCH_CAP = 730_000;
const LUNCH_AMOUNT = 800_000;
const PHONE_AMOUNT = 300_000;
const DUTY_AMOUNT = 500_000;
const BASE = 20_000_000;

function cellsOf(line: string): string[] {
  return line.split('","').map((one) => one.replace(/^"|"$/g, ""));
}

describe("user-maintained catalogues (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  const token = { admin: "", hr: "", payroll: "" };
  let titleId = "";
  let entityId = "";
  let otherEntityId = "";
  let topId = "";
  let childId = "";
  let workerId = 0;
  let lunchId = "";
  let phoneId = "";
  let dutyId = "";

  async function sweep(): Promise<void> {
    await db.employee.deleteMany({ where: { code: WORKER } });
    await db.department.deleteMany({ where: { code: CHILD } });
    await db.department.deleteMany({ where: { code: { in: [TOP, ELSEWHERE] } } });
    await db.legalEntity.deleteMany({ where: { code: { in: [ENTITY, OTHER_ENTITY] } } });
    await db.jobTitle.deleteMany({ where: { code: TITLE } });
    await db.allowanceType.deleteMany({ where: { code: { in: [LUNCH, PHONE, DUTY] } } });
  }

  async function signIn(email: string): Promise<string> {
    const res = await request(http)
      .post("/auth/login")
      .send({ email, password: validateEnv().SEED_ADMIN_PASSWORD ?? "" });
    assert.equal(res.status, 200, `${email} could not sign in`);
    return res.body.accessToken as string;
  }

  function by(who: keyof typeof token) {
    return {
      get: (path: string) => request(http).get(path).set("Authorization", `Bearer ${token[who]}`),
      post: (path: string, body: object) =>
        request(http).post(path).set("Authorization", `Bearer ${token[who]}`).send(body),
      patch: (path: string, body: object) =>
        request(http).patch(path).set("Authorization", `Bearer ${token[who]}`).send(body),
    };
  }

  before(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    http = app.getHttpServer();
    db = app.get(PrismaService);
    await sweep();
    token.admin = await signIn("admin@kiosk.local");
    token.hr = await signIn("hr@kiosk.local");
    token.payroll = await signIn("payroll@kiosk.local");
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("adds a job title, refuses its code twice, and writes it down", async () => {
    const made = await by("hr").post("/job-titles", {
      code: TITLE,
      name: "Kỹ thuật viên",
      grade: 3,
      laborCategory: "HIGH_SKILLED",
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    titleId = made.body.id;
    assert.equal(made.body.laborCategory, "HIGH_SKILLED");

    const again = await by("hr").post("/job-titles", { code: TITLE, name: "Trùng" });
    assert.equal(again.status, 409);
    assert.equal(again.body.message, "JOB_TITLE_CODE_TAKEN");

    const trail = await db.auditLog.findFirst({ where: { subjectType: "jobTitle", subjectId: titleId } });
    assert.equal(trail?.action, "jobTitle.create");
  });

  it("keeps job titles away from the payroll desk", async () => {
    const res = await by("payroll").post("/job-titles", { code: "E2ECAT-NO", name: "Không" });
    assert.equal(res.status, 403);
  });

  it("hides a retired job title from pickers and lists it when asked for all", async () => {
    const retired = await by("hr").patch(`/job-titles/${titleId}`, { active: false });
    assert.equal(retired.status, 200, JSON.stringify(retired.body));
    const pickers = await by("hr").get("/job-titles");
    assert.equal(
      (pickers.body as { id: string }[]).some((one) => one.id === titleId),
      false,
      "a retired title still offered to the hiring form",
    );
    const everything = await by("hr").get("/job-titles?all=true");
    assert.ok((everything.body as { id: string }[]).some((one) => one.id === titleId));
    const restored = await by("hr").patch(`/job-titles/${titleId}`, { active: true });
    assert.equal(restored.status, 200);
    const trail = await db.auditLog.findFirst({
      where: { subjectType: "jobTitle", subjectId: titleId, action: "jobTitle.update" },
      orderBy: { id: "desc" },
    });
    assert.deepEqual((trail?.meta as { active?: unknown } | null)?.active, { from: false, to: true });
  });

  it("lets only an admin add a legal entity, once per code", async () => {
    const byHr = await by("hr").post("/legal-entities", { code: ENTITY, name: "Pháp nhân thử" });
    assert.equal(byHr.status, 403);
    const made = await by("admin").post("/legal-entities", {
      code: ENTITY,
      name: "Pháp nhân thử",
      taxCode: "0101234567",
      address: "Hà Nội",
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    entityId = made.body.id;
    const other = await by("admin").post("/legal-entities", { code: OTHER_ENTITY, name: "Pháp nhân khác" });
    assert.equal(other.status, 201);
    otherEntityId = other.body.id;
    const again = await by("admin").post("/legal-entities", { code: ENTITY, name: "Trùng" });
    assert.equal(again.status, 409);
    assert.equal(again.body.message, "ENTITY_CODE_TAKEN");
  });

  it("opens a department tree under the new entity", async () => {
    const top = await by("hr").post("/departments", { legalEntityId: entityId, code: TOP, name: "Khối thử" });
    assert.equal(top.status, 201, JSON.stringify(top.body));
    topId = top.body.id;
    const child = await by("hr").post("/departments", {
      legalEntityId: entityId,
      code: CHILD,
      name: "Phòng con",
      parentId: topId,
    });
    assert.equal(child.status, 201, JSON.stringify(child.body));
    childId = child.body.id;
    const elsewhere = await by("hr").post("/departments", {
      legalEntityId: otherEntityId,
      code: ELSEWHERE,
      name: "Phòng pháp nhân khác",
    });
    assert.equal(elsewhere.status, 201);

    const worker = await db.employee.create({
      data: {
        code: WORKER,
        fullName: "Người của danh mục",
        active: true,
        legalEntityId: entityId,
        departmentId: childId,
        jobTitleId: titleId,
      },
    });
    workerId = worker.id;
  });

  it("refuses to move a department under its own child", async () => {
    const res = await by("hr").patch(`/departments/${topId}`, { parentId: childId });
    assert.equal(res.status, 409);
    assert.equal(res.body.message, "DEPARTMENT_CYCLE");
  });

  it("refuses a parent from another legal entity", async () => {
    const other = await db.department.findFirstOrThrow({ where: { code: ELSEWHERE } });
    const res = await by("hr").patch(`/departments/${childId}`, { parentId: other.id });
    assert.equal(res.status, 409);
    assert.equal(res.body.message, "DEPARTMENT_ENTITY_MISMATCH");
  });

  it("refuses to retire a department with people, or with a live child", async () => {
    const withPeople = await by("hr").patch(`/departments/${childId}`, { active: false });
    assert.equal(withPeople.status, 409);
    assert.equal(withPeople.body.message, "DEPARTMENT_IN_USE");
    const withChild = await by("hr").patch(`/departments/${topId}`, { active: false });
    assert.equal(withChild.status, 409);
    assert.equal(withChild.body.message, "DEPARTMENT_IN_USE");
  });

  it("sets a head and a cost centre, and the tree reads them back", async () => {
    const res = await by("hr").patch(`/departments/${childId}`, { headId: workerId, costCentre: "CC-9" });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const tree = await by("hr").get(`/departments?legalEntityId=${entityId}`);
    const node = (tree.body as { id: string; head: { code: string } | null; costCentre: string | null }[]).find(
      (one) => one.id === childId,
    );
    assert.equal(node?.head?.code, WORKER);
    assert.equal(node?.costCentre, "CC-9");
  });

  it("retires an empty department and still lists it when asked for all", async () => {
    await db.employee.update({ where: { id: workerId }, data: { departmentId: null } });
    const res = await by("hr").patch(`/departments/${childId}`, { active: false });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const live = await by("hr").get(`/departments?legalEntityId=${entityId}`);
    assert.equal((live.body as { id: string }[]).some((one) => one.id === childId), false);
    const all = await by("hr").get(`/departments?legalEntityId=${entityId}&all=true`);
    assert.ok((all.body as { id: string }[]).some((one) => one.id === childId));
    const trail = await db.auditLog.findFirst({ where: { subjectType: "department", subjectId: childId } });
    assert.ok(trail, "a department write left nothing in the log");
  });

  it("refuses to retire a legal entity that still files somebody", async () => {
    const res = await by("admin").patch(`/legal-entities/${entityId}`, { active: false });
    assert.equal(res.status, 409);
    assert.equal(res.body.message, "ENTITY_IN_USE");
  });

  it("retires an empty legal entity", async () => {
    const res = await by("admin").patch(`/legal-entities/${otherEntityId}`, { active: false });
    assert.equal(res.status, 409, "a live department still sits under it");
    await db.department.updateMany({ where: { code: ELSEWHERE }, data: { active: false } });
    const retired = await by("admin").patch(`/legal-entities/${otherEntityId}`, { active: false });
    assert.equal(retired.status, 200, JSON.stringify(retired.body));
    const all = await by("hr").get("/legal-entities?all=true");
    assert.ok((all.body as { id: string; active: boolean }[]).some((one) => one.id === otherEntityId && !one.active));
  });

  it("renames a holiday and refuses a year that is not a number", async () => {
    const made = await db.holiday.create({
      data: { legalEntityId: entityId, date: new Date("2031-09-02T00:00:00.000Z"), name: "Quốc khánh" },
    });
    const renamed = await by("hr").patch(`/holidays/${made.id}`, { name: "Quốc khánh 2/9", paid: false });
    assert.equal(renamed.status, 200, JSON.stringify(renamed.body));
    assert.equal(renamed.body.paid, false);
    const ghost = await by("hr").patch("/holidays/00000000-0000-0000-0000-000000000000", { name: "Không có" });
    assert.equal(ghost.status, 404);
    assert.equal(ghost.body.message, "HOLIDAY_NOT_FOUND");
    const bad = await by("hr").get("/holidays?year=abc");
    assert.equal(bad.status, 400);
  });

  it("keeps allowance types with the pay desk; the hr desk reads them", async () => {
    const byHr = await by("hr").post("/allowance-types", { code: LUNCH, name: "Tiền ăn ca" });
    assert.equal(byHr.status, 403);
    const lunch = await by("payroll").post("/allowance-types", {
      code: LUNCH,
      name: "Tiền ăn ca",
      taxable: true,
      insurable: false,
      taxFreeCap: LUNCH_CAP,
      d02Column: 16,
    });
    assert.equal(lunch.status, 201, JSON.stringify(lunch.body));
    lunchId = lunch.body.id;
    const phone = await by("payroll").post("/allowance-types", {
      code: PHONE,
      name: "Điện thoại",
      insurable: true,
      d02Column: 16,
    });
    assert.equal(phone.status, 201);
    phoneId = phone.body.id;
    const duty = await by("payroll").post("/allowance-types", {
      code: DUTY,
      name: "Chức vụ",
      insurable: true,
      d02Column: 13,
    });
    assert.equal(duty.status, 201);
    dutyId = duty.body.id;

    const again = await by("payroll").post("/allowance-types", { code: LUNCH, name: "Trùng" });
    assert.equal(again.status, 409);
    assert.equal(again.body.message, "ALLOWANCE_CODE_TAKEN");
    const offForm = await by("payroll").post("/allowance-types", { code: "E2ECAT-X", name: "Sai cột", d02Column: 12 });
    assert.equal(offForm.status, 400);
    const read = await by("hr").get("/allowance-types");
    assert.equal(read.status, 200);
  });

  it("copies the type's rules onto a pay record, and a later edit leaves the copy alone", async () => {
    const made = await by("hr").post("/compensation", {
      employeeId: workerId,
      effectiveFrom: PAY_FROM,
      baseSalary: BASE,
      insuranceSalary: BASE,
      reason: "HIRE",
      allowances: [
        { allowanceTypeId: lunchId, amount: LUNCH_AMOUNT },
        { allowanceTypeId: phoneId, amount: PHONE_AMOUNT },
        { allowanceTypeId: dutyId, amount: DUTY_AMOUNT },
      ],
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const lunch = (made.body.allowances as { code: string; label: string; taxable: boolean; taxFreeCap: string; d02Column: number; typeId: string }[]).find(
      (one) => one.code === LUNCH,
    );
    assert.equal(lunch?.label, "Tiền ăn ca");
    assert.equal(lunch?.taxable, true);
    assert.equal(Number(lunch?.taxFreeCap), LUNCH_CAP);
    assert.equal(lunch?.d02Column, 16);
    assert.equal(lunch?.typeId, lunchId);

    const edited = await by("payroll").patch(`/allowance-types/${lunchId}`, { taxable: false, name: "Ăn trưa" });
    assert.equal(edited.status, 200);
    const kept = await db.compensationAllowance.findFirstOrThrow({ where: { typeId: lunchId } });
    assert.equal(kept.taxable, true, "editing a type repriced a month already written");
    assert.equal(kept.label, "Tiền ăn ca");
  });

  it("refuses the same allowance type twice, and a second record on one date", async () => {
    const twice = await by("hr").post("/compensation", {
      employeeId: workerId,
      effectiveFrom: "2026-03-01",
      baseSalary: BASE,
      insuranceSalary: BASE,
      reason: "ADJUSTMENT",
      allowances: [
        { allowanceTypeId: lunchId, amount: 1 },
        { allowanceTypeId: lunchId, amount: 2 },
      ],
    });
    assert.equal(twice.status, 400);
    assert.equal(twice.body.message, "ALLOWANCE_TYPE_REPEATED");
    const sameDay = await by("hr").post("/compensation", {
      employeeId: workerId,
      effectiveFrom: PAY_FROM,
      baseSalary: BASE,
      insuranceSalary: BASE,
      reason: "ADJUSTMENT",
    });
    assert.equal(sameDay.status, 409);
    assert.equal(sameDay.body.message, "PAY_DATE_TAKEN");
  });

  it("keeps the payroll desk from setting pay, and anybody from setting their own", async () => {
    const byPayroll = await by("payroll").post("/compensation", {
      employeeId: workerId,
      effectiveFrom: "2026-04-01",
      baseSalary: BASE,
      insuranceSalary: BASE,
      reason: "ADJUSTMENT",
    });
    assert.equal(byPayroll.status, 403);
    const self = await db.employee.findUniqueOrThrow({ where: { code: HR_CODE } });
    const own = await by("hr").post("/compensation", {
      employeeId: self.id,
      effectiveFrom: "2031-01-01",
      baseSalary: BASE,
      insuranceSalary: BASE,
      reason: "ADJUSTMENT",
    });
    assert.equal(own.status, 403);
    assert.equal(own.body.message, "SELF_DECISION");
    const bulkByPayroll = await by("payroll").post("/compensation/bulk/preview", {
      effectiveFrom: "2031-01-01",
      percentBp: 100,
      reason: "ANNUAL_REVIEW",
      employeeIds: [workerId],
    });
    assert.equal(bulkByPayroll.status, 403);
  });

  it("carries allowances forward when a bulk raise writes the next record", async () => {
    const raised = await by("hr").post("/compensation/bulk", {
      effectiveFrom: "2026-05-01",
      percentBp: 1000,
      reason: "ANNUAL_REVIEW",
      employeeIds: [workerId],
    });
    assert.equal(raised.status, 201, JSON.stringify(raised.body));
    const next = await db.compensationRecord.findFirstOrThrow({
      where: { employeeId: workerId, effectiveFrom: new Date("2026-05-01") },
      include: { allowances: true },
    });
    assert.equal(next.allowances.length, 3, "a raise dropped the allowances out of the next payslip");
  });

  it("fills D02-LT columns 8 to 11 from the title and 13 to 17 from each type's column", async () => {
    await db.employee.update({ where: { id: workerId }, data: { hireDate: new Date(PAY_FROM) } });
    const res = await by("admin").get(`/reports/d02-lt?legalEntityId=${entityId}&on=${D02_ON}`);
    assert.equal(res.status, 200);
    const rows = res.text.slice(BOM.length).split("\r\n").map(cellsOf);
    const row = rows.slice(1).find((one) => one[1] === "Người của danh mục");
    assert.ok(row, "the worker is missing from the filing");
    assert.equal(row[8], "x", "a high-skilled title belongs in column 9");
    assert.equal(row[7], "");
    assert.equal(row[15], String(LUNCH_AMOUNT + PHONE_AMOUNT), "two allowances on column 16 add up");
    assert.equal(row[12], String(DUTY_AMOUNT), "the duty allowance belongs in column 13");
    assert.equal(row[13], "");
  });
});
