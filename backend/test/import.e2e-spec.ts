import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { deflateRawSync } from "node:zlib";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import ExcelJS from "exceljs";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { UNUSABLE_PASSWORD } from "../src/modules/auth/password.js";
import { IMPORT_COLUMNS, IMPORT_MAX_BYTES, IMPORT_MAX_ROWS, parseCsv, readRows } from "../src/modules/employees/import.js";
import { IMPORT_MAX_INFLATED_BYTES, XLSX_MIME } from "../src/modules/employees/workbook.js";
import { QUEUE_TOKEN, type Queues } from "../src/queue/queue.module.js";
import { QUEUE, type PasswordSetupJob } from "../src/queue/queues.js";

const PREFIX = "E2EIMP";

function quoted(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
const ENTITY = "DEFAULT";
const HEAD = "code,fullName,legalEntityCode,managerCode,dateOfBirth,gender,baseSalary,insuranceSalary";
const MAIL_DOMAIN = "@import.example";

interface Fault {
  row: number;
  column: string;
  code: string;
  value: string;
}

interface Report {
  applied: boolean;
  rows: number;
  toCreate: number;
  toUpdate: number;
  unchanged: number;
  payKept: number;
  shiftsToAssign: number;
  kiosksToAssign: number;
  loginsToOpen: number;
  consentsToRecord: number;
  changes: { row: number; code: string; fields: string[]; cleared: string[] }[];
  faults: Fault[];
  warnings: Fault[];
}

const OTHER_ENTITY = `${PREFIX}-LE`;
const OTHER_DEPARTMENT = `${PREFIX}-D`;
const RETIRED_DEPARTMENT = `${PREFIX}-OLD`;
const FRESH_DEPARTMENT = `${PREFIX}-NEW`;
const CLOSING_DEPARTMENT = `${PREFIX}-RET`;
const SHIFT = `${PREFIX} ca sáng`;
const KIOSK = "e2eimp-kiosk";
const PAPER_KIOSK = "e2eimp-kiosk-paper";
const KEPT_DEPARTMENT = `${PREFIX}-KEEP`;
const KEPT_TITLE = `${PREFIX}-JT`;

function csvOf(header: readonly string[], rows: readonly string[][]): string {
  return [header, ...rows].map((line) => line.map(quoted).join(",")).join("\r\n");
}

async function xlsxOf(header: readonly string[], rows: readonly string[][]): Promise<Buffer> {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet("employees");
  sheet.addRow([...header]);
  rows.forEach((row) => sheet.addRow(row));
  return Buffer.from(await book.xlsx.writeBuffer());
}

/** A zip whose one sheet inflates past the budget while the file itself stays small. */
function bomb(): Buffer {
  const size = IMPORT_MAX_INFLATED_BYTES + 1;
  const body = deflateRawSync(Buffer.alloc(size, 32));
  const name = Buffer.from("xl/worksheets/sheet1.xml");
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(size, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(size, 24);
  central.writeUInt16LE(name.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(local.length + name.length + body.length, 16);
  return Buffer.concat([local, name, body, central, name, end]);
}

describe("employee import (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let queues: Queues;
  let token = "";
  let startedAt = new Date();

  async function sweep(): Promise<void> {
    await db.employee.deleteMany({ where: { code: { startsWith: PREFIX } } });
    await db.user.deleteMany({ where: { email: { endsWith: MAIL_DOMAIN } } });
    await db.department.deleteMany({
      where: {
        code: { in: [OTHER_DEPARTMENT, RETIRED_DEPARTMENT, FRESH_DEPARTMENT, CLOSING_DEPARTMENT, KEPT_DEPARTMENT] },
      },
    });
    await db.legalEntity.deleteMany({ where: { code: OTHER_ENTITY } });
    await db.jobTitle.deleteMany({ where: { code: KEPT_TITLE } });
    await db.shift.deleteMany({ where: { name: SHIFT } });
    await db.device.deleteMany({ where: { id: { in: [KIOSK, PAPER_KIOSK] } } });
  }

  async function send(csv: string, apply: boolean): Promise<Report> {
    const res = await request(http)
      .post(`/employees/import${apply ? "?apply=true" : ""}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ csv });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body as Report;
  }

  function upload(body: Buffer | string, type: string, apply = false): Promise<request.Response> {
    return request(http)
      .post(`/employees/import${apply ? "?apply=true" : ""}`)
      .set("Authorization", `Bearer ${token}`)
      .set("Content-Type", type)
      .send(body);
  }

  async function fetched(path: string): Promise<Buffer> {
    const res = await request(http)
      .get(path)
      .set("Authorization", `Bearer ${token}`)
      .buffer(true)
      .parse((body, done) => {
        const chunks: Buffer[] = [];
        body.on("data", (chunk: Buffer) => chunks.push(chunk));
        body.on("end", () => done(null, Buffer.concat(chunks)));
      });
    assert.equal(res.status, 200, path);
    return res.body as Buffer;
  }

  async function book(bytes: Buffer): Promise<ExcelJS.Workbook> {
    const read = new ExcelJS.Workbook();
    await read.xlsx.load(new Uint8Array(bytes).buffer);
    return read;
  }

  /** The drop-down entries of one column, read off the range its validation points at. */
  function entriesOf(workbook: ExcelJS.Workbook, column: string): string[] {
    const people = workbook.getWorksheet("employees") as ExcelJS.Worksheet;
    const at = IMPORT_COLUMNS.indexOf(column as (typeof IMPORT_COLUMNS)[number]) + 1;
    const letter = people.getColumn(at).letter;
    const held = (people as unknown as { dataValidations: { model: Record<string, ExcelJS.DataValidation> } })
      .dataValidations.model;
    const rule = held[`${letter}2`];
    assert.equal(rule?.type, "list", `${column} carries no drop-down`);
    assert.ok(held[`${letter}${IMPORT_MAX_ROWS + 1}`], `${column} has no drop-down on the last line an import takes`);
    const range = /^catalogues!\$([A-Z]+)\$2:\$[A-Z]+\$(\d+)$/.exec(String(rule?.formulae[0]));
    assert.ok(range, `${column} points at ${String(rule?.formulae[0])}, not the catalogues sheet`);
    const lists = workbook.getWorksheet("catalogues") as ExcelJS.Worksheet;
    const source = lists.getColumn(range[1] as string);
    assert.equal(source.values[1], column, "the catalogues column is not headed by the column it feeds");
    return source.values.slice(2, Number(range[2]) + 1).map((one) => String(one ?? ""));
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
    queues = app.get(QUEUE_TOKEN);
    await sweep();
    startedAt = new Date();

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

  it("counts a blank line in the middle, so the line named is the one Excel shows", async () => {
    const report = await send(["code,fullName,dateOfBirth", `${PREFIX}06,Sáu,`, ",,", `${PREFIX}07,Bảy,99-99-99`].join("\r\n"), false);
    assert.equal(faultAt(report, "DATE_INVALID")?.row, 4);
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

  it("writes only the columns the file names, and says so when it keeps an address or a bank", async () => {
    const code = `${PREFIX}30`;
    const first = await send(
      [
        "code,fullName,legalEntityCode,personalEmail,phone,nationalId,bankAccount,bankName",
        `${code},Người ba mươi,${ENTITY},first${MAIL_DOMAIN},0901000001,079000000030,111,Ngân hàng A`,
      ].join("\r\n"),
      true,
    );
    assert.equal(first.applied, true, JSON.stringify(first.faults));
    const second = await send(
      ["code,fullName,personalEmail,bankAccount,bankName", `${code},Người ba mươi mốt,second${MAIL_DOMAIN},222,Ngân hàng A`].join(
        "\r\n",
      ),
      true,
    );
    assert.equal(second.applied, true, "a warning blocked the write");
    assert.deepEqual(
      second.warnings.map((one) => [one.row, one.column, one.code]),
      [
        [2, "personalEmail", "CHANGE_BY_REQUEST"],
        [2, "bankAccount", "CHANGE_BY_REQUEST"],
      ],
      "the dry run hid that the address and the account stay as they are, or named an unchanged bank",
    );
    const held = await db.employee.findUniqueOrThrow({ where: { code } });
    assert.equal(held.fullName, "Người ba mươi mốt");
    assert.equal(held.phone, "0901000001", "a column the file left out was wiped");
    assert.equal(held.nationalId, "079000000030", "a column the file left out was wiped");
    assert.equal(held.personalEmail, `first${MAIL_DOMAIN}`, "an import moved the address a change is reported to");
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

  it("reads a department inside the line's legal entity, and says when one is retired", async () => {
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
        `${PREFIX}55,Chọn từ ô,,${OTHER_DEPARTMENT} · Phòng thử · ${OTHER_ENTITY}`,
        `${PREFIX}56,Ô lệch dòng,${ENTITY},${OTHER_DEPARTMENT} · Phòng thử · ${OTHER_ENTITY}`,
      ].join("\r\n"),
      false,
    );
    const at = (row: number) => report.faults.filter((one) => one.row === row).map((one) => one.code);
    assert.deepEqual(at(2), ["DEPARTMENT_UNKNOWN"], "a department of another entity was accepted");
    assert.deepEqual(at(3), [], "the line's own entity did not find its department");
    assert.deepEqual(at(4), ["DEPARTMENT_RETIRED"], "a retired department took a new person");
    assert.deepEqual(at(5), ["LEGAL_ENTITY_UNKNOWN"]);
    assert.deepEqual(at(6), ["LEGAL_ENTITY_REQUIRED"], "two entities and none named still guessed one");
    assert.deepEqual(at(7), [], "a department entry naming its entity did not place the person there");
    assert.deepEqual(at(8), ["DEPARTMENT_ENTITY_MISMATCH"], "an entry of another entity went in under this one");
  });

  it("exports a formula as text Excel will not run, and imports it back unchanged", async () => {
    const payload = "=HYPERLINK(\"http://attacker.example\",\"x\")";
    const row = await db.employee.findFirstOrThrow({ where: { code: { startsWith: PREFIX } } });
    await db.employee.update({ where: { id: row.id }, data: { phone: payload } });
    const res = await request(http)
      .get(`/employees/export?search=${PREFIX}&format=csv`)
      .set("Authorization", `Bearer ${token}`);
    const grid = parseCsv(res.text);
    const at = (grid[0] as string[]).indexOf("phone");
    const line = grid.find((cells) => cells[0] === row.code) as string[];
    assert.equal(line[at], `'${payload}`, "the export handed Excel a live formula");
    const back = [grid[0] as string[], line].map((cells) => cells.map(quoted).join(",")).join("\r\n");
    assert.equal(readRows(back).rows[0]?.phone, payload, "the text mark came back in on import");

    const sheet = (await book(await fetched(`/employees/export?search=${PREFIX}`))).getWorksheet("employees");
    const cell = sheet?.getRow(1).values as string[];
    const written = sheet?.getRows(2, sheet.rowCount)?.find((one) => one.getCell(1).value === row.code);
    const value = written?.getCell(cell.indexOf("phone")).value;
    assert.equal(value, payload, "the xlsx did not keep the text");
    assert.equal(typeof value, "string", "the xlsx wrote the cell as a formula");
    await db.employee.update({ where: { id: row.id }, data: { phone: row.phone } });
  });

  it("builds the template from the catalogues of this moment, a department added a second ago included", async () => {
    const entity = await db.legalEntity.findUniqueOrThrow({ where: { code: ENTITY } });
    const made = await request(http)
      .post("/departments")
      .set("Authorization", `Bearer ${token}`)
      .send({ legalEntityId: entity.id, code: FRESH_DEPARTMENT, name: "Phòng vừa thêm" });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const workbook = await book(await fetched("/employees/import/template"));
    const people = workbook.getWorksheet("employees") as ExcelJS.Worksheet;
    assert.deepEqual((people.getRow(1).values as string[]).slice(1), [...IMPORT_COLUMNS], "the header is not the importer's");
    assert.equal(people.views[0]?.state, "frozen", "the header scrolls away");
    const departments = entriesOf(workbook, "departmentCode");
    assert.ok(
      departments.some((one) => one.startsWith(`${FRESH_DEPARTMENT} · Phòng vừa thêm`)),
      "the department added a moment ago is not in the drop-down",
    );
    assert.ok(!departments.some((one) => one.startsWith(`${RETIRED_DEPARTMENT} ·`)), "a retired department is offered");
    assert.ok(entriesOf(workbook, "legalEntityCode").some((one) => one.startsWith(`${ENTITY} · `)));
    assert.deepEqual(entriesOf(workbook, "gender"), ["MALE", "FEMALE"]);
    assert.deepEqual(entriesOf(workbook, "openLogin"), ["YES", "NO"]);
  });

  it("catches a department retired since the template was downloaded, at the dry run", async () => {
    const entity = await db.legalEntity.findUniqueOrThrow({ where: { code: ENTITY } });
    const made = await request(http)
      .post("/departments")
      .set("Authorization", `Bearer ${token}`)
      .send({ legalEntityId: entity.id, code: CLOSING_DEPARTMENT, name: "Phòng sắp đóng" });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const workbook = await book(await fetched("/employees/import/template"));
    const picked = entriesOf(workbook, "departmentCode").find((one) => one.startsWith(`${CLOSING_DEPARTMENT} ·`));
    const entityEntry = entriesOf(workbook, "legalEntityCode").find((one) => one.startsWith(`${ENTITY} · `));
    assert.ok(picked && entityEntry);
    const retired = await request(http)
      .patch(`/departments/${made.body.id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ active: false });
    assert.equal(retired.status, 200, JSON.stringify(retired.body));

    const res = await upload(
      await xlsxOf(["code", "fullName", "legalEntityCode", "departmentCode"], [[`${PREFIX}80`, "Người tám mươi", entityEntry, picked]]),
      XLSX_MIME,
      true,
    );
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const report = res.body as Report;
    assert.deepEqual(
      report.faults.map((one) => [one.row, one.column, one.code]),
      [[2, "departmentCode", "DEPARTMENT_RETIRED"]],
    );
    assert.equal(report.applied, false);
    assert.equal(await db.employee.count({ where: { code: `${PREFIX}80` } }), 0, "the retired department slipped into the write");
  });

  it("gives the same report for the same lines as xlsx and as csv", async () => {
    const header = ["code", "fullName", "legalEntityCode", "dateOfBirth", "gender", "openLogin", "phone"];
    const rows = [
      [`${PREFIX}90`, "Nguyễn Thị Lộc Ngọc Ánh", `${ENTITY} · Mặc định`, "1994-05-06", "FEMALE", "YES", "0901234567"],
      [`${PREFIX}91`, "Trần Văn Đức", ENTITY, "06/05/1994", "MALE", "MAYBE", "=1+1"],
      [`${PREFIX}20`, "Tên đã đổi", "", "1992-02-02", "FEMALE", "", ""],
    ];
    const asCsv = await upload(csvOf(header, rows), "text/csv");
    const asXlsx = await upload(await xlsxOf(header, rows), XLSX_MIME);
    assert.equal(asCsv.status, 201, JSON.stringify(asCsv.body));
    assert.equal(asXlsx.status, 201, JSON.stringify(asXlsx.body));
    assert.deepEqual(asXlsx.body, asCsv.body, "the two formats disagree about the same lines");
    const report = asCsv.body as Report;
    assert.deepEqual(
      report.faults.map((one) => [one.row, one.code]),
      [
        [3, "DATE_INVALID"],
        [3, "FLAG_INVALID"],
      ],
    );
    assert.deepEqual(report.warnings.map((one) => [one.row, one.code]), [[2, "LOGIN_NO_EMAIL"]]);
  });

  it("puts a new person on a shift from a day, once, however often the file comes back", async () => {
    await db.shift.create({ data: { name: SHIFT, startTime: "08:00", endTime: "17:00" } });
    const file = csvOf(["code", "fullName", "legalEntityCode", "hireDate", "shiftName", "shiftFrom"], [
      [`${PREFIX}60`, "Người sáu mươi", ENTITY, "2030-01-02", `${SHIFT} · 08:00–17:00`, ""],
    ]);
    const first = (await upload(file, "text/csv", true)).body as Report;
    assert.equal(first.applied, true, JSON.stringify(first.faults));
    assert.equal(first.shiftsToAssign, 1);
    const person = await db.employee.findUniqueOrThrow({ where: { code: `${PREFIX}60` }, include: { shifts: true } });
    assert.deepEqual(
      person.shifts.map((one) => one.validFrom.toISOString().slice(0, 10)),
      ["2030-01-02"],
      "an empty start day did not fall back to the hire date",
    );
    const again = (await upload(file, "text/csv", true)).body as Report;
    assert.deepEqual([again.shiftsToAssign, again.toUpdate, again.unchanged], [0, 0, 1], "the same file twice wrote twice");
    assert.equal(await db.shiftAssignment.count({ where: { employeeId: person.id } }), 1);
  });

  it("assigns a kiosk only with consent, bumps its roster once, and never flips a held face to retake", async () => {
    await db.device.create({ data: { id: KIOSK, status: "APPROVED", rosterVersion: 5 } });
    const file = csvOf(["code", "fullName", "legalEntityCode", "kioskId"], [
      [`${PREFIX}61`, "Người sáu mốt", ENTITY, KIOSK],
      [`${PREFIX}62`, "Người sáu hai", ENTITY, `${KIOSK} · Cửa chính`],
    ]);
    const unconsented = (await upload(file, "text/csv", true)).body as Report;
    assert.equal(unconsented.applied, true, "a missing consent blocked the whole file");
    assert.deepEqual(unconsented.warnings.map((one) => [one.row, one.column, one.code]), [
      [2, "kioskId", "KIOSK_NO_CONSENT"],
      [3, "kioskId", "KIOSK_NO_CONSENT"],
    ]);
    assert.equal(await db.deviceEnrollment.count({ where: { deviceId: KIOSK } }), 0, "a kiosk took a face nobody consented to");

    const people = await db.employee.findMany({ where: { code: { in: [`${PREFIX}61`, `${PREFIX}62`] } } });
    await db.biometricConsent.createMany({
      data: people.map((one) => ({ employeeId: one.id, noticeVersion: "e2e", method: "PAPER" })),
    });
    const dry = (await upload(file, "text/csv")).body as Report;
    assert.deepEqual([dry.kiosksToAssign, dry.warnings.length], [2, 0]);
    assert.equal(await db.deviceEnrollment.count({ where: { deviceId: KIOSK } }), 0, "the dry run wrote a pair");
    const seated = (await upload(file, "text/csv", true)).body as Report;
    assert.equal(seated.applied, true);
    const pairs = await db.deviceEnrollment.findMany({ where: { deviceId: KIOSK } });
    assert.deepEqual(pairs.map((one) => one.state), ["ASSIGNED", "ASSIGNED"]);
    const device = await db.device.findUniqueOrThrow({ where: { id: KIOSK } });
    assert.equal(device.rosterVersion, 7, "the roster did not move by the batch, once");

    await db.deviceEnrollment.updateMany({ where: { deviceId: KIOSK }, data: { state: "ENROLLED" } });
    const again = (await upload(file, "text/csv", true)).body as Report;
    assert.equal(again.kiosksToAssign, 0);
    const kept = await db.deviceEnrollment.findMany({ where: { deviceId: KIOSK } });
    assert.deepEqual(kept.map((one) => one.state), ["ENROLLED", "ENROLLED"], "a re-import sent held faces back to retake");
    assert.equal((await db.device.findUniqueOrThrow({ where: { id: KIOSK } })).rosterVersion, 7);
  });

  it("opens a login and queues its letter only once the file is written", async () => {
    const email = `${PREFIX.toLowerCase()}63${MAIL_DOMAIN}`;
    const file = csvOf(["code", "fullName", "legalEntityCode", "personalEmail", "openLogin"], [
      [`${PREFIX}63`, "Người sáu ba", ENTITY, email, "YES"],
      [`${PREFIX}64`, "Không có thư", ENTITY, "", "YES"],
    ]);
    const dry = (await upload(file, "text/csv")).body as Report;
    assert.equal(dry.loginsToOpen, 1);
    assert.deepEqual(dry.warnings.map((one) => [one.row, one.code]), [[3, "LOGIN_NO_EMAIL"]]);
    assert.equal(await db.user.count({ where: { email } }), 0, "the dry run opened a login");

    const done = (await upload(file, "text/csv", true)).body as Report;
    assert.equal(done.applied, true);
    const login = await db.user.findUniqueOrThrow({ where: { email } });
    assert.equal(login.passwordHash, UNUSABLE_PASSWORD, "the import minted a password");
    assert.equal(await db.passwordSetup.count({ where: { userId: login.id } }), 1);
    const jobs = await queues[QUEUE.notify].getJobs(["waiting", "delayed", "completed", "active", "failed"]);
    const letter = jobs.map((job) => job.data as PasswordSetupJob).find((data) => data.userId === login.id);
    assert.ok(letter, "no letter was queued for the login the import opened");
    assert.equal(letter.reason, "opened");
    const again = (await upload(file, "text/csv", true)).body as Report;
    assert.equal(again.loginsToOpen, 0, "a second pass opened a second login");
  });

  it("writes one audit line per person it creates or changes, field names only", async () => {
    const before = await db.auditLog.count({ where: { subjectType: "route", subjectId: "/employees/import" } });
    const phone = "0909123456";
    const report = await send(
      ["code,fullName,legalEntityCode,phone", `${PREFIX}70,Bảy mươi,${ENTITY},`, `${PREFIX}71,Bảy mốt,${ENTITY},`, `${PREFIX}20,Tên đã đổi,,${phone}`].join(
        "\r\n",
      ),
      true,
    );
    assert.deepEqual([report.toCreate, report.toUpdate], [2, 1]);
    const people = await db.employee.findMany({ where: { code: { in: [`${PREFIX}70`, `${PREFIX}71`, `${PREFIX}20`] } } });
    const lines = await db.auditLog.findMany({
      where: { subjectType: "employee", subjectId: { in: people.map((one) => String(one.id)) }, ts: { gte: startedAt } },
      orderBy: { id: "desc" },
    });
    const created = lines.filter((one) => one.action === "employee.create" && one.actorId);
    const updatedOf20 = lines.find(
      (one) => one.action === "employee.update" && one.subjectId === String(people.find((p) => p.code === `${PREFIX}20`)?.id),
    );
    assert.ok(created.some((one) => (one.meta as { code?: string }).code === `${PREFIX}70`));
    assert.ok(created.some((one) => (one.meta as { code?: string }).code === `${PREFIX}71`));
    assert.deepEqual((updatedOf20?.meta as { fields?: string[] }).fields, ["phone"]);
    assert.ok(!JSON.stringify(updatedOf20?.meta).includes(phone), "the trail kept a copy of the value");
    assert.equal(
      await db.auditLog.count({ where: { subjectType: "route", subjectId: "/employees/import" } }),
      before,
      "the call still left one generic route line",
    );
  });

  it("keeps what an empty cell leaves, clears what a - names, and lists both before writing", async () => {
    const entity = await db.legalEntity.findUniqueOrThrow({ where: { code: ENTITY } });
    await db.department.create({ data: { legalEntityId: entity.id, code: KEPT_DEPARTMENT, name: "Phòng giữ nguyên" } });
    const title = await db.jobTitle.create({ data: { code: KEPT_TITLE, name: "Chức danh giữ nguyên" } });
    const code = `${PREFIX}85`;
    const header = ["code", "fullName", "legalEntityCode", "phone", "dateOfBirth", "departmentCode", "jobTitleCode", "managerCode", "nationalId"];
    const seeded = await upload(
      csvOf(header, [[code, "Tám lăm", ENTITY, "0901000085", "1990-08-05", KEPT_DEPARTMENT, title.code, `${PREFIX}21`, ""]]),
      "text/csv",
      true,
    );
    assert.equal(seeded.body.applied, true, JSON.stringify(seeded.body));

    const edit = csvOf(header, [
      [code, "", "", "", "-", "-", "", "-", "079000000085"],
      [`${PREFIX}86`, "Tám sáu", ENTITY, "-", "", "", "", "", ""],
    ]);
    const dry = (await upload(edit, "text/csv")).body as Report;
    assert.deepEqual(dry.faults, [], "a - on a new person is not just an empty cell");
    assert.deepEqual([dry.toCreate, dry.toUpdate], [1, 1]);
    assert.deepEqual(
      dry.changes,
      [{ row: 2, code, fields: ["nationalId"], cleared: ["dateOfBirth", "departmentCode", "managerCode"] }],
      "the dry run did not spell out what Apply writes and empties",
    );
    const done = (await upload(edit, "text/csv", true)).body as Report;
    assert.equal(done.applied, true);
    const held = await db.employee.findUniqueOrThrow({ where: { code } });
    assert.deepEqual(
      [held.fullName, held.phone, held.jobTitleId, held.legalEntityId],
      ["Tám lăm", "0901000085", title.id, entity.id],
      "an empty cell wiped what it should have kept",
    );
    assert.deepEqual([held.dateOfBirth, held.departmentId, held.managerId], [null, null, null], "a - did not clear");
    assert.equal(held.nationalId, "079000000085");
    assert.equal((await db.employee.findUniqueOrThrow({ where: { code: `${PREFIX}86` } })).phone, null);
    const line = await db.auditLog.findFirstOrThrow({
      where: { subjectType: "employee", subjectId: String(held.id), action: "employee.update" },
      orderBy: { id: "desc" },
    });
    assert.deepEqual(line.meta, { code, fields: ["nationalId"], cleared: ["dateOfBirth", "departmentCode", "managerCode"], source: "import" });

    const refused = (await upload(csvOf(["code", "fullName", "legalEntityCode", "baseSalary"], [[code, "-", "-", "-"]]), "text/csv")).body as Report;
    assert.deepEqual(
      refused.faults.map((one) => [one.column, one.code]),
      [
        ["fullName", "CLEAR_NOT_ALLOWED"],
        ["legalEntityCode", "CLEAR_NOT_ALLOWED"],
        ["baseSalary", "CLEAR_NOT_ALLOWED"],
      ],
      "a - reached a column that cannot be emptied",
    );
  });

  it("records a paper consent inside the import, so the same line's kiosk assigns in one run", async () => {
    await db.device.create({ data: { id: PAPER_KIOSK, status: "APPROVED" } });
    const env = validateEnv();
    const admin = await db.user.findUniqueOrThrow({ where: { email: "admin@kiosk.local" } });
    const gone = await db.employee.create({ data: { code: `${PREFIX}88`, fullName: "Đã nghỉ", active: false } });
    const file = csvOf(["code", "fullName", "legalEntityCode", "consentPaper", "kioskId"], [
      [`${PREFIX}87`, "Tám bảy", ENTITY, "YES", PAPER_KIOSK],
      [gone.code, "Đã nghỉ", "", "YES", ""],
    ]);
    const dry = (await upload(file, "text/csv")).body as Report;
    assert.deepEqual([dry.consentsToRecord, dry.kiosksToAssign], [1, 1]);
    assert.deepEqual(dry.warnings.map((one) => [one.row, one.column, one.code]), [[3, "consentPaper", "EMPLOYEE_HAS_LEFT"]]);
    assert.equal(await db.biometricConsent.count({ where: { employee: { code: `${PREFIX}87` } } }), 0, "the dry run wrote a consent");

    const done = (await upload(file, "text/csv", true)).body as Report;
    assert.equal(done.applied, true, JSON.stringify(done.faults));
    const person = await db.employee.findUniqueOrThrow({ where: { code: `${PREFIX}87` } });
    const consents = await db.biometricConsent.findMany({ where: { employeeId: person.id } });
    assert.deepEqual(
      consents.map((one) => [one.state, one.method, one.noticeVersion, one.recordedById]),
      [["GRANTED", "PAPER", env.BIOMETRIC_NOTICE_VERSION, admin.id]],
      "the consent is not the one the profile's button records",
    );
    const pair = await db.deviceEnrollment.findUnique({
      where: { deviceId_employeeId: { deviceId: PAPER_KIOSK, employeeId: person.id } },
    });
    assert.equal(pair?.state, "ASSIGNED", "the kiosk waited for another run");
    const granted = await db.auditLog.findMany({
      where: { subjectType: "employee", subjectId: String(person.id), action: "biometric.consent.grant" },
    });
    assert.deepEqual(
      granted.map((one) => [one.actorId, one.meta]),
      [[admin.id, { noticeVersion: env.BIOMETRIC_NOTICE_VERSION, method: "PAPER" }]],
    );
    assert.equal(await db.biometricConsent.count({ where: { employeeId: gone.id } }), 0, "someone who left was given a consent");

    const again = (await upload(file, "text/csv", true)).body as Report;
    assert.deepEqual([again.consentsToRecord, again.kiosksToAssign, again.unchanged], [0, 0, 2]);
    const declined = (await upload(csvOf(["code", "consentPaper"], [[person.code, "NO"]]), "text/csv", true)).body as Report;
    assert.equal(declined.applied, true);
    assert.equal(
      await db.biometricConsent.count({ where: { employeeId: person.id, state: "GRANTED" } }),
      1,
      "a NO withdrew a consent",
    );
  });

  it("takes its own export straight back and changes nothing", async () => {
    const exported = await fetched(`/employees/export?search=${PREFIX}`);
    const mine = await db.employee.findMany({ where: { code: { startsWith: PREFIX } }, orderBy: { code: "asc" } });
    const trailOf = () =>
      db.auditLog.count({ where: { subjectType: "employee", subjectId: { in: mine.map((one) => String(one.id)) } } });
    const trail = await trailOf();
    const res = await upload(exported, XLSX_MIME, true);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const report = res.body as Report;
    assert.deepEqual(report.faults, [], "the file this system writes is a file it refuses");
    assert.deepEqual(report.warnings, [], "its own export warns about itself");
    assert.deepEqual(
      [report.rows, report.toCreate, report.toUpdate, report.unchanged],
      [mine.length, 0, 0, mine.length],
      "a round trip counts as a change",
    );
    assert.deepEqual([report.shiftsToAssign, report.kiosksToAssign, report.loginsToOpen], [0, 0, 0]);
    const after = await db.employee.findMany({ where: { code: { startsWith: PREFIX } }, orderBy: { code: "asc" } });
    assert.deepEqual(
      after.map((one) => one.updatedAt.getTime()),
      mine.map((one) => one.updatedAt.getTime()),
      "a round trip rewrote records",
    );
    assert.equal(await trailOf(), trail, "a round trip left audit lines");

    const csv = (await request(http).get(`/employees/export?search=${PREFIX}&format=csv`).set("Authorization", `Bearer ${token}`)).text;
    assert.ok(csv.startsWith("﻿"), "Excel needs the byte order mark");
    assert.deepEqual(parseCsv(csv)[0], [...IMPORT_COLUMNS], "the header is the importer's own");
    const back = (await upload(csv, "text/csv")).body as Report;
    assert.deepEqual([back.faults.length, back.toUpdate, back.unchanged], [0, 0, mine.length]);
  });

  it("refuses a file too big, too long or unzipping too far, before reading it", async () => {
    const heavy = await upload(Buffer.alloc(IMPORT_MAX_BYTES + 1, 65), XLSX_MIME);
    assert.deepEqual([heavy.status, heavy.body.message], [413, "BODY_TOO_LARGE"]);

    const burst = await upload(bomb(), XLSX_MIME);
    assert.deepEqual([burst.status, burst.body.message], [413, "IMPORT_FILE_TOO_LARGE"], "a zip bomb was opened");

    const lines = Array.from({ length: IMPORT_MAX_ROWS + 1 }, (_, at) => [`${PREFIX}X${at}`, "Dòng"]);
    const long = await upload(csvOf(["code", "fullName"], lines), "text/csv");
    assert.deepEqual([long.status, long.body.message], [413, "IMPORT_TOO_MANY_ROWS"]);
    const longSheet = await upload(await xlsxOf(["code", "fullName"], lines), XLSX_MIME);
    assert.deepEqual([longSheet.status, longSheet.body.message], [413, "IMPORT_TOO_MANY_ROWS"]);

    const junk = await upload(Buffer.from("not a spreadsheet at all"), XLSX_MIME);
    assert.deepEqual([junk.status, junk.body.message], [400, "IMPORT_FILE_UNREADABLE"]);
    assert.equal(await db.employee.count({ where: { code: { startsWith: `${PREFIX}X` } } }), 0);
  });
});
