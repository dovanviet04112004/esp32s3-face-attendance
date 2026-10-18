import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { BYTE_ORDER_MARK } from "../src/common/csv.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { cellsOf, signIn } from "./fixtures.js";

// An entity of its own, and a search term only this suite's people answer to.
const ENTITY_CODE = "E2E-RGX";
const DEPARTMENT_CODE = "E2E-RGX-D";
const SEARCH = "E2ERX";
const PLAIN = "E2ERX01";
const RISKY = "E2ERX02";
const CODES = [PLAIN, RISKY];
const RISKY_NAME = "=1+2 E2ERX";
const TAX_CODE = "8001234567";
const NATIONAL_ID = "079200001234";
const ADVANCE = 3_000_000;

type Login = "admin" | "hr" | "payroll" | "manager" | "employee";

// One table each, with the desks that hold its queue and the state of the risky row.
const KINDS: { path: string; action: string; subject: string; allowed: Login[]; refused: Login[]; riskyState: string }[] = [
  {
    path: "/payslip-disputes",
    action: "export.disputes",
    subject: "disputes",
    allowed: ["payroll"],
    refused: ["hr", "manager", "employee"],
    riskyState: "ANSWERED",
  },
  {
    path: "/certificates",
    action: "export.certificates",
    subject: "certificates",
    allowed: ["hr", "payroll"],
    refused: ["manager", "employee"],
    riskyState: "ISSUED",
  },
  {
    path: "/profile-changes",
    action: "export.profileChanges",
    subject: "profile-changes",
    allowed: ["hr"],
    refused: ["payroll", "manager", "employee"],
    riskyState: "APPROVED",
  },
  {
    path: "/dependents",
    action: "export.dependents",
    subject: "dependents",
    allowed: ["payroll"],
    refused: ["hr", "manager", "employee"],
    riskyState: "ACTIVE",
  },
  {
    path: "/advances",
    action: "export.advances",
    subject: "advances",
    allowed: ["hr", "payroll"],
    refused: ["manager", "employee"],
    riskyState: "PAID",
  },
];

function rowsOf(text: string): string[][] {
  return text.slice(BYTE_ORDER_MARK.length).split("\r\n").map(cellsOf);
}

function dateOf(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

describe("exporting the register's tabs (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  const token: Record<Login, string> = { admin: "", hr: "", payroll: "", manager: "", employee: "" };
  const idOf = new Map<string, number>();

  async function sweep(): Promise<void> {
    await db.payrollPeriod.deleteMany({ where: { legalEntity: { code: ENTITY_CODE } } });
    await db.employee.deleteMany({ where: { code: { in: CODES } } });
    await db.department.deleteMany({ where: { code: DEPARTMENT_CODE } });
    await db.legalEntity.deleteMany({ where: { code: ENTITY_CODE } });
  }

  const get = (who: Login, path: string) => request(http).get(path).set("Authorization", `Bearer ${token[who]}`);

  before(async () => {
    const env = validateEnv();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    http = app.getHttpServer();
    db = app.get(PrismaService);
    await sweep();

    const password = env.SEED_ADMIN_PASSWORD ?? "";
    for (const who of Object.keys(token) as Login[]) {
      token[who] = await signIn(http, `${who}@kiosk.local`, password);
    }
    const desk = await db.user.findUniqueOrThrow({ where: { email: "payroll@kiosk.local" } });

    const entity = await db.legalEntity.create({ data: { code: ENTITY_CODE, name: "Pháp nhân thử xuất sổ" } });
    const department = await db.department.create({
      data: { legalEntityId: entity.id, code: DEPARTMENT_CODE, name: "Phòng thử xuất sổ" },
    });
    for (const code of CODES) {
      const made = await db.employee.create({
        data: {
          code,
          fullName: code === RISKY ? RISKY_NAME : `Thử xuất sổ ${code}`,
          active: true,
          legalEntityId: entity.id,
          departmentId: department.id,
          hireDate: dateOf("2025-01-01"),
        },
      });
      idOf.set(code, made.id);
    }
    const plain = idOf.get(PLAIN) as number;
    const risky = idOf.get(RISKY) as number;

    // A dispute needs an issued payslip; any policy row satisfies its key.
    const policy = await db.payrollPolicy.findFirstOrThrow({ orderBy: { effectiveFrom: "asc" } });
    const period = await db.payrollPeriod.create({
      data: { legalEntityId: entity.id, year: 2026, month: 1, startDate: dateOf("2026-01-01"), endDate: dateOf("2026-01-31") },
    });
    const run = await db.payrollRun.create({ data: { periodId: period.id, kind: "REGULAR", state: "DONE" } });
    for (const employeeId of [plain, risky]) {
      const slip = await db.payslip.create({
        data: { runId: run.id, periodId: period.id, employeeId, policyId: policy.id, state: "ISSUED" },
      });
      const answered = employeeId === risky;
      await db.payslipDispute.create({
        data: {
          payslipId: slip.id,
          employeeId,
          lineCode: "OT",
          claim: "Thiếu bốn giờ tăng ca",
          dueAt: dateOf("2026-02-15"),
          ...(answered
            ? { state: "ANSWERED", outcome: "REJECTED", answer: "Đã đối chiếu, không thiếu", answeredAt: new Date(), answeredById: desk.id }
            : {}),
        },
      });
    }

    await db.certificate.createMany({
      data: [
        { employeeId: plain, kind: "EMPLOYMENT", purpose: "Vay ngân hàng" },
        {
          employeeId: risky,
          kind: "INCOME",
          purpose: "Xin thị thực",
          months: 3,
          state: "ISSUED",
          serial: "E2ERX-00001",
          issuedAt: new Date(),
          issuedById: desk.id,
        },
      ],
    });
    await db.profileChange.createMany({
      data: [
        { employeeId: plain, field: "PHONE", oldValue: { phone: "0901000001" }, newValue: { phone: "0901000002" } },
        {
          employeeId: risky,
          field: "BANK",
          oldValue: { bankName: "VCB", bankAccount: "0011" },
          newValue: { bankName: "ACB", bankAccount: "0022" },
          state: "APPROVED",
          decidedById: desk.id,
          decidedAt: new Date(),
        },
      ],
    });
    await db.dependent.createMany({
      data: [
        { employeeId: plain, fullName: "Con thử xuất", relation: "CHILD", fromMonth: dateOf("2026-01-01") },
        {
          employeeId: risky,
          fullName: "Vợ thử xuất",
          relation: "SPOUSE",
          fromMonth: dateOf("2025-06-01"),
          taxCode: TAX_CODE,
          nationalId: NATIONAL_ID,
          state: "ACTIVE",
          decidedById: desk.id,
          decidedAt: new Date(),
        },
      ],
    });
    await db.salaryAdvance.createMany({
      data: [
        { employeeId: plain, amount: ADVANCE, reason: "Viện phí" },
        { employeeId: risky, amount: ADVANCE, reason: "Sửa nhà", state: "PAID", decidedById: desk.id, decidedAt: new Date(), paidAt: new Date() },
      ],
    });
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("puts in each file exactly the rows its list returns under the same filter", async () => {
    for (const kind of KINDS) {
      const listed = await get("admin", `${kind.path}?search=${SEARCH}&take=50`);
      assert.equal(listed.status, 200, `${kind.path}: ${JSON.stringify(listed.body)}`);
      const file = await get("admin", `${kind.path}/export?search=${SEARCH}`);
      assert.equal(file.status, 200, `${kind.path}/export: ${file.text}`);
      assert.ok(file.text.startsWith(BYTE_ORDER_MARK), `${kind.path}: Excel needs the byte order mark`);
      const [header, ...rows] = rowsOf(file.text);
      assert.equal(header[0], "code");
      assert.deepEqual(
        rows.map((row) => row[0]),
        listed.body.rows.map((row: { employee: { code: string } }) => row.employee.code),
        `${kind.path}: the file and the list disagree`,
      );
      assert.equal(rows.length, CODES.length);
    }
  });

  it("narrows the file by state as it narrows the list", async () => {
    for (const kind of KINDS) {
      const file = await get("admin", `${kind.path}/export?search=${SEARCH}&state=${kind.riskyState}`);
      assert.equal(file.status, 200, `${kind.path}/export: ${file.text}`);
      const [header, ...rows] = rowsOf(file.text);
      assert.deepEqual(rows.map((row) => row[0]), [RISKY], `${kind.path}: the state filter was not applied`);
      assert.equal(rows[0][header.indexOf("state")], kind.riskyState);
      assert.notEqual(rows[0][header.indexOf("decidedBy")], "", `${kind.path}: the decider is missing`);
    }
  });

  it("opens each file only to the desks holding that queue", async () => {
    for (const kind of KINDS) {
      for (const who of kind.allowed) {
        const file = await get(who, `${kind.path}/export?search=${SEARCH}`);
        assert.equal(file.status, 200, `${who} could not export ${kind.path}: ${file.text}`);
      }
      for (const who of kind.refused) {
        const file = await get(who, `${kind.path}/export?search=${SEARCH}`);
        assert.equal(file.status, 403, `${who} exported ${kind.path}`);
      }
    }
  });

  it("writes a name Excel would run as a formula as plain text", async () => {
    for (const kind of KINDS) {
      const [header, ...rows] = rowsOf((await get("admin", `${kind.path}/export?search=${SEARCH}`)).text);
      const risky = rows.find((row) => row[0] === RISKY);
      assert.equal(risky?.[header.indexOf("fullName")], `'${RISKY_NAME}`, `${kind.path}: a formula reached the file`);
    }
  });

  it("carries each tab's own columns, and no identity number of a dependant", async () => {
    const cellOf = async (path: string, column: string) => {
      const [header, ...rows] = rowsOf((await get("admin", `${path}/export?search=${SEARCH}`)).text);
      return rows.find((row) => row[0] === RISKY)?.[header.indexOf(column)];
    };
    assert.equal(await cellOf("/payslip-disputes", "period"), "2026-01");
    assert.equal(await cellOf("/payslip-disputes", "outcome"), "REJECTED");
    assert.equal(await cellOf("/certificates", "serial"), "E2ERX-00001");
    assert.equal(await cellOf("/profile-changes", "oldValue"), "VCB · 0011");
    assert.equal(await cellOf("/profile-changes", "newValue"), "ACB · 0022");
    assert.equal(await cellOf("/dependents", "fromMonth"), "2025-06");
    assert.equal(await cellOf("/advances", "amount"), String(ADVANCE));

    const dependants = (await get("admin", `/dependents/export?search=${SEARCH}`)).text;
    assert.ok(!dependants.includes(TAX_CODE), "a dependant's tax code reached the file");
    assert.ok(!dependants.includes(NATIONAL_ID), "a dependant's identity number reached the file");
  });

  it("leaves one audit line per download, with the filter and the row count", async () => {
    const actor = await db.user.findUniqueOrThrow({ where: { email: "admin@kiosk.local" } });
    for (const kind of KINDS) {
      const where = { actorId: actor.id, action: kind.action };
      const earlier = await db.auditLog.count({ where });
      const file = await get("admin", `${kind.path}/export?search=${SEARCH}&state=${kind.riskyState}`);
      assert.equal(file.status, 200);
      assert.equal(await db.auditLog.count({ where }), earlier + 1, `${kind.path}: not one audit line for one download`);
      const line = await db.auditLog.findFirstOrThrow({ where, orderBy: { id: "desc" } });
      assert.equal(line.subjectId, kind.subject);
      const meta = line.meta as { filters: { search?: string; state?: string }; rows: number };
      assert.equal(meta.rows, 1);
      assert.equal(meta.filters.search, SEARCH);
      assert.equal(meta.filters.state, kind.riskyState);
    }
  });
});
