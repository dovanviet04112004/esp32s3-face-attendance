import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";

const DEPT = "E2ECE-DEPT";
const FIRST = "NV9181E";
const SECOND = "NV9182E";
const MADE_CODES = [FIRST, SECOND];
const PAYROLL_CODE = "NV0011";
const DOC = "E2ECE-DOC";
const FILE_TYPE = "E2ECE-KSK";
const TITLE = "E2ECE-TITLE";
const PLAIN = "E2ECE mọi người";
const EXACT = "E2ECE đúng chức danh";
const SHIFT = "E2ECE ca thử";
const SEED_SHIFT = "Hành chính";
const ASSET = "E2ECE-TS01";
const DEPENDANT = "E2ECE người phụ thuộc";
const RECEIVED_ON = "2026-01-31";
const LAST_OF_FEBRUARY = "2026-02-28";

interface Page<T> {
  rows: T[];
  total: number;
  next: string | null;
}

describe("catalogue edits and the lists around them (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  const token = { admin: "", hr: "", payroll: "", manager: "" };
  const idOf = new Map<string, number>();
  let deptId = "";
  let documentId = "";
  let fileTypeId = "";
  let titleId = "";
  let plainId = "";
  let exactId = "";
  let shiftId = "";
  let assetId = "";

  async function sweep(): Promise<void> {
    await db.dependent.deleteMany({ where: { fullName: DEPENDANT } });
    await db.employee.deleteMany({ where: { code: { in: MADE_CODES } } });
    await db.document.deleteMany({ where: { code: DOC } });
    await db.personnelFileType.deleteMany({ where: { code: FILE_TYPE } });
    await db.checklistTemplate.deleteMany({ where: { name: { in: [PLAIN, EXACT] } } });
    await db.jobTitle.deleteMany({ where: { code: TITLE } });
    await db.shift.deleteMany({ where: { name: SHIFT } });
    await db.asset.deleteMany({ where: { code: ASSET } });
    await db.department.deleteMany({ where: { code: DEPT } });
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
    token.manager = await signIn("manager@kiosk.local");

    const template = await db.employee.findFirstOrThrow({ where: { active: true, legalEntityId: { not: null } } });
    const dept = await db.department.create({
      data: { code: DEPT, name: "Phòng sửa danh mục", legalEntityId: template.legalEntityId as string },
    });
    deptId = dept.id;
    for (const [at, code] of MADE_CODES.entries()) {
      const made = await db.employee.create({
        data: {
          code,
          fullName: `Người sửa danh mục ${at + 1}`,
          active: true,
          legalEntityId: template.legalEntityId,
          departmentId: deptId,
        },
      });
      idOf.set(code, made.id);
    }
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("re-aims and retires a document, and lists it again when asked for all", async () => {
    const made = await by("hr").post("/documents", { code: DOC, title: "Quy định phòng", kind: "NOTICE" });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    documentId = made.body.id;
    const aimed = await by("hr").patch(`/documents/${documentId}`, { departmentId: deptId, kind: "POLICY" });
    assert.equal(aimed.status, 200, JSON.stringify(aimed.body));
    assert.equal(aimed.body.departmentId, deptId);
    const published = await by("hr").post(`/documents/${documentId}/versions`, { body: "Điều 1." });
    assert.equal(published.status, 201);

    const retired = await by("hr").patch(`/documents/${documentId}`, { active: false });
    assert.equal(retired.status, 200);
    const live = await by("hr").get("/documents");
    assert.equal((live.body as { id: string }[]).some((one) => one.id === documentId), false);
    const all = await by("hr").get("/documents?all=true");
    assert.ok((all.body as { id: string }[]).some((one) => one.id === documentId));
    await by("hr").patch(`/documents/${documentId}`, { active: true });
    const trail = await db.auditLog.findFirst({ where: { subjectType: "document", subjectId: documentId, action: "document.update" } });
    assert.ok(trail, "a document edit left nothing in the log");
  });

  it("reads a named version, finds a reader by code, and narrows to the unsigned", async () => {
    const version = await db.documentVersion.findFirstOrThrow({ where: { documentId } });
    await db.documentAck.create({ data: { versionId: version.id, employeeId: idOf.get(SECOND) as number } });

    const named = await by("hr").get(`/documents/${documentId}/readers?version=1`);
    assert.equal(named.status, 200, "asking for a version by number is a normal question");
    assert.equal((named.body as Page<unknown>).total, 2);

    const found = await by("hr").get(`/documents/${documentId}/readers?search=${FIRST.toLowerCase()}`);
    const rows = (found.body as Page<{ code: string }>).rows;
    assert.deepEqual(rows.map((one) => one.code), [FIRST]);

    const unsigned = await by("hr").get(`/documents/${documentId}/readers?unsigned=true`);
    const left = (unsigned.body as Page<{ code: string }>).rows.map((one) => one.code);
    assert.deepEqual(left, [FIRST], "somebody who signed is still listed as unsigned");
  });

  it("edits a kind of paper and holds its expiry to the end of a short month", async () => {
    const made = await by("hr").post("/personnel-file-types", { code: FILE_TYPE, name: "Khám sức khoẻ", validMonths: 12 });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    fileTypeId = made.body.id;
    const edited = await by("hr").patch(`/personnel-file-types/${fileTypeId}`, { name: "Giấy khám sức khoẻ", validMonths: 1 });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.validMonths, 1);

    const filed = await by("hr").post("/personnel-files", {
      employeeId: idOf.get(FIRST),
      typeId: fileTypeId,
      receivedAt: RECEIVED_ON,
    });
    assert.equal(filed.status, 201, JSON.stringify(filed.body));
    assert.equal(String(filed.body.expiresAt).slice(0, 10), LAST_OF_FEBRUARY);
  });

  it("keeps the file gap list to the desk and narrows it by person and department", async () => {
    const asManager = await by("manager").get("/personnel-files/gaps");
    assert.equal(asManager.status, 403);
    const found = await by("hr").get(`/personnel-files/gaps?search=${SECOND}`);
    assert.equal(found.status, 200);
    const codes = (found.body as Page<{ code: string }>).rows.map((one) => one.code);
    assert.ok(codes.every((code) => code === SECOND), "a search by code brought back other people");
    const inDept = await by("hr").get(`/personnel-files/gaps?departmentId=${deptId}`);
    const people = (inDept.body as Page<{ code: string }>).rows.map((one) => one.code);
    assert.ok(people.every((code) => MADE_CODES.includes(code)), "a department filter let other departments in");
  });

  it("retires a kind of paper, which stops it counting as missing", async () => {
    const retired = await by("hr").patch(`/personnel-file-types/${fileTypeId}`, { active: false });
    assert.equal(retired.status, 200);
    const all = await by("hr").get("/personnel-file-types?all=true");
    assert.ok((all.body as { id: string; active: boolean }[]).some((one) => one.id === fileTypeId && !one.active));
  });

  it("edits a template: renames it, replaces its items and retires it", async () => {
    const title = await db.jobTitle.create({ data: { code: TITLE, name: "Chức danh sửa mẫu" } });
    titleId = title.id;
    const plain = await by("hr").post("/checklist-templates", {
      kind: "ONBOARDING",
      name: PLAIN,
      items: [{ title: "Ký hợp đồng", owner: "HR", dueDays: 0 }],
    });
    assert.equal(plain.status, 201, JSON.stringify(plain.body));
    plainId = plain.body.id;
    const exact = await by("hr").post("/checklist-templates", {
      kind: "ONBOARDING",
      name: "Tạm",
      jobTitleId: titleId,
      items: [
        { title: "Cấp máy", owner: "HR", dueDays: 0 },
        { title: "Gặp nhóm", owner: "MANAGER", dueDays: 1 },
      ],
    });
    assert.equal(exact.status, 201);
    exactId = exact.body.id;

    const edited = await by("hr").patch(`/checklist-templates/${exactId}`, {
      name: EXACT,
      items: [{ title: "Cấp máy và tài khoản", owner: "HR", dueDays: -1 }],
    });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    assert.equal(edited.body.name, EXACT);
    assert.deepEqual(
      (edited.body.items as { title: string; ordinal: number }[]).map((one) => [one.ordinal, one.title]),
      [[1, "Cấp máy và tài khoản"]],
    );
    const trail = await db.auditLog.findFirst({ where: { subjectType: "checklistTemplate", subjectId: exactId } });
    assert.ok(trail, "a template edit left nothing in the log");
  });

  it("starts somebody with no job title on a template written for no job title", async () => {
    const run = await by("hr").post("/checklists", {
      employeeId: idOf.get(FIRST),
      kind: "ONBOARDING",
      anchorDate: "2026-10-01",
    });
    assert.equal(run.status, 201, JSON.stringify(run.body));
    assert.notEqual(run.body.template.name, EXACT, "a title-specific template reached somebody with no title");
  });

  it("hides a retired template unless asked for all", async () => {
    const retired = await by("hr").patch(`/checklist-templates/${plainId}`, { active: false });
    assert.equal(retired.status, 200);
    const live = await by("hr").get("/checklist-templates?kind=ONBOARDING");
    assert.equal((live.body as { id: string }[]).some((one) => one.id === plainId), false);
    const all = await by("hr").get("/checklist-templates?kind=ONBOARDING&all=true");
    assert.ok((all.body as { id: string }[]).some((one) => one.id === plainId));
    const badKind = await by("hr").get("/checklist-templates?kind=SIDEWAYS");
    assert.equal(badKind.status, 400);
  });

  it("puts many people on a shift at once and skips the ones already there", async () => {
    const shift = await by("hr").post("/shifts", { name: SHIFT, startTime: "06:00", endTime: "14:00" });
    assert.equal(shift.status, 201, JSON.stringify(shift.body));
    shiftId = shift.body.id;
    const body = { employeeIds: MADE_CODES.map((code) => idOf.get(code)), validFrom: "2026-10-01T00:00:00.000Z" };
    const first = await by("hr").post(`/shifts/${shiftId}/assignments/bulk?apply=true`, body);
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.deepEqual([first.body.assigned, first.body.skipped], [2, []]);
    const again = await by("hr").post(`/shifts/${shiftId}/assignments/bulk?apply=true`, body);
    assert.equal(again.body.assigned, 0);
    assert.deepEqual(
      (again.body.skipped as { reason: string }[]).map((one) => one.reason),
      ["ALREADY_ON_SHIFT", "ALREADY_ON_SHIFT"],
    );
    const ghost = await by("hr").post(`/shifts/${shiftId}/assignments/bulk?apply=true`, { ...body, employeeIds: [999_999] });
    assert.equal(ghost.status, 201);
    assert.deepEqual(
      (ghost.body.skipped as { employeeId: number; reason: string }[]).map((one) => [one.employeeId, one.reason]),
      [[999_999, "EMPLOYEE_NOT_FOUND"]],
    );
  });

  it("pages the roster and finds one person on it", async () => {
    const paged = await by("hr").get(`/shifts/${shiftId}/assignments?take=1`);
    assert.equal(paged.status, 200);
    const page = paged.body as Page<unknown>;
    assert.equal(page.total, 2);
    assert.equal(page.rows.length, 1);
    assert.ok(page.next, "a page that stops short gives no way on");
    const found = await by("hr").get(`/shifts/${shiftId}/assignments?search=${SECOND}`);
    const rows = (found.body as Page<{ employee: { code: string; department: { id: string } | null } }>).rows;
    assert.deepEqual(rows.map((one) => one.employee.code), [SECOND]);
    assert.equal(rows[0]?.employee.department?.id, deptId);
  });

  it("refuses to rename a shift onto a name another shift holds", async () => {
    const res = await by("hr").patch(`/shifts/${shiftId}`, { name: SEED_SHIFT });
    assert.equal(res.status, 409);
    assert.equal(res.body.message, "SHIFT_NAME_TAKEN");
  });

  it("corrects an asset, refuses its code twice, and exports what the filter shows", async () => {
    const made = await by("hr").post("/assets", { code: ASSET, name: "Máy tính thử", kind: "LAPTPO" });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assetId = made.body.id;
    const again = await by("hr").post("/assets", { code: ASSET, name: "Trùng", kind: "LAPTOP" });
    assert.equal(again.status, 409);
    assert.equal(again.body.message, "ASSET_CODE_TAKEN");

    const fixed = await by("hr").patch(`/assets/${assetId}`, { kind: "LAPTOP", serialNo: "SN-1", note: "Hộp còn" });
    assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
    assert.equal(fixed.body.kind, "LAPTOP");
    const trail = await db.auditLog.findFirst({ where: { subjectType: "asset", subjectId: ASSET, action: "asset.update" } });
    assert.ok(trail, "an asset edit left nothing in the log");

    const counts = await by("hr").get(`/assets/counts?search=${ASSET}`);
    assert.equal(counts.body.states.IN_STOCK, 1);
    const file = await by("hr").get(`/assets/export?search=${ASSET}`);
    assert.equal(file.status, 200);
    assert.match(file.text, new RegExp(ASSET));
    assert.equal(file.text.split("\r\n").length, 2, "the export ignored the filter");
  });

  it("lists waiting dependants by person and department, never the desk's own", async () => {
    const own = await db.employee.findUniqueOrThrow({ where: { code: PAYROLL_CODE } });
    await db.dependent.createMany({
      data: [
        { employeeId: idOf.get(FIRST) as number, fullName: DEPENDANT, relation: "CHILD", fromMonth: new Date("2026-01-01") },
        { employeeId: own.id, fullName: DEPENDANT, relation: "CHILD", fromMonth: new Date("2026-01-01") },
      ],
    });
    const waiting = await by("payroll").get("/dependents?state=PENDING&take=200");
    assert.equal(waiting.status, 200);
    const people = (waiting.body as Page<{ employee: { code: string } }>).rows.map((one) => one.employee.code);
    assert.equal(people.includes(PAYROLL_CODE), false, "the desk sees its own registration waiting");

    const found = await by("payroll").get(`/dependents?search=${FIRST}`);
    const rows = (found.body as Page<{ employee: { code: string; department: { id: string } | null } }>).rows;
    assert.deepEqual(rows.map((one) => one.employee.code), [FIRST]);
    assert.equal(rows[0]?.employee.department?.id, deptId);

    const inDept = await by("payroll").get(`/dependents?departmentId=${deptId}`);
    assert.ok((inDept.body as Page<{ employee: { code: string } }>).rows.every((one) => one.employee.code === FIRST));

    const badState = await by("payroll").get("/dependents?state=MAYBE");
    assert.equal(badState.status, 400);
  });

  it("decides a dependant once, and never one's own", async () => {
    const theirs = await db.dependent.findFirstOrThrow({ where: { fullName: DEPENDANT, employeeId: idOf.get(FIRST) } });
    const first = await by("payroll").post(`/dependents/${theirs.id}/decide`, { approve: true });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.state, "ACTIVE");
    const second = await by("payroll").post(`/dependents/${theirs.id}/decide`, { approve: false, note: "Muộn" });
    assert.equal(second.status, 409);
    assert.equal(second.body.message, "REQUEST_ALREADY_DECIDED");

    const own = await db.employee.findUniqueOrThrow({ where: { code: PAYROLL_CODE } });
    const mine = await db.dependent.findFirstOrThrow({ where: { fullName: DEPENDANT, employeeId: own.id } });
    const self = await by("payroll").post(`/dependents/${mine.id}/decide`, { approve: true });
    assert.equal(self.status, 403);
    assert.equal(self.body.message, "SELF_DECISION");
  });
});
