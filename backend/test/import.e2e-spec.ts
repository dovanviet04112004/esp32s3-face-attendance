import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { IMPORT_COLUMNS, parseCsv } from "../src/modules/employees/import.js";

const PREFIX = "E2EIMP";

function quoted(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}
const HEAD = "code,fullName,managerCode,dateOfBirth,gender,baseSalary,insuranceSalary";

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
  faults: Fault[];
}

describe("employee import (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let token = "";

  async function sweep(): Promise<void> {
    await db.employee.deleteMany({ where: { code: { startsWith: PREFIX } } });
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
        `${PREFIX}01,Người một,,1990-01-01,MALE,1000,900`,
        `,Không có mã,,,,,`,
        `${PREFIX}03,Ngày sai,,01-01-1990,,,`,
        `${PREFIX}04,Giới tính sai,,,OTHER,,`,
        `${PREFIX}05,Nửa vế lương,,,,1000,`,
        `${PREFIX}01,Trùng mã,,,,,`,
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
      [HEAD, `${PREFIX}10,Người mười,,,,,`, `${PREFIX}11,Ngày sai,,31-31-2026,,,`].join("\r\n"),
      true,
    );
    assert.equal(report.applied, false);
    assert.equal(await db.employee.count({ where: { code: { startsWith: PREFIX } } }), 0);
  });

  it("creates on a clean file and links a manager the file names later", async () => {
    const report = await send(
      [
        HEAD,
        `${PREFIX}20,Nhân viên,${PREFIX}21,1992-02-02,FEMALE,12000000,10000000`,
        `${PREFIX}21,Quản lý,,1980-03-03,MALE,20000000,18000000`,
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

  it("updates on a second pass and makes no second row", async () => {
    const report = await send(
      [HEAD, `${PREFIX}20,Tên đã đổi,${PREFIX}21,1992-02-02,FEMALE,13000000,11000000`].join("\r\n"),
      true,
    );
    assert.equal(report.toUpdate, 1);
    assert.equal(report.toCreate, 0);
    const staff = await db.employee.findUnique({
      where: { code: `${PREFIX}20` },
      include: { compensation: true },
    });
    assert.equal(staff?.fullName, "Tên đã đổi");
    assert.equal(staff?.compensation.length, 1, "one effective date holds one record");
    assert.equal(staff?.compensation[0]?.insuranceSalary.toFixed(0), "11000000");
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
