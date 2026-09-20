import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";

const ON = "2026-06-01";
const COLUMNS = 27;
const BOM = "﻿";

const THIN = "NV9601";
const GONE = "NV9602";
const LAPSED = "NV9603";
const ELSEWHERE = "NV9604";
const MADE_CODES = [THIN, GONE, LAPSED, ELSEWHERE];
const OTHER_ENTITY = "E2E-OTHER";

function cellsOf(line: string): string[] {
  return line
    .split('","')
    .map((one) => one.replace(/^"|"$/g, ""));
}

describe("d02-lt extract (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let token = "";
  let entityId = "";
  let otherId = "";

  async function sweep(): Promise<void> {
    await db.employee.deleteMany({ where: { code: { in: MADE_CODES } } });
    await db.legalEntity.deleteMany({ where: { code: OTHER_ENTITY } });
  }

  async function extract(): Promise<string[][]> {
    const res = await request(http)
      .get(`/reports/d02-lt?legalEntityId=${entityId}&on=${ON}`)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.ok(res.text.startsWith(BOM), "Excel needs the byte order mark");
    return res.text.slice(BOM.length).split("\r\n").map(cellsOf);
  }

  function rowOf(rows: string[][], name: string): string[] | undefined {
    return rows.slice(1).find((row) => row[1] === name);
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

    const template = await db.employee.findFirstOrThrow({
      where: { active: true, legalEntityId: { not: null } },
    });
    entityId = template.legalEntityId as string;
    const other = await db.legalEntity.create({
      data: { code: OTHER_ENTITY, name: "Pháp nhân khác" },
    });
    otherId = other.id;

    await db.employee.create({
      data: { code: THIN, fullName: "Không đủ hồ sơ", active: true, legalEntityId: entityId },
    });
    await db.employee.create({
      data: {
        code: GONE,
        fullName: "Đã nghỉ trước kỳ",
        active: false,
        legalEntityId: entityId,
        hireDate: new Date("2025-01-01T00:00:00.000Z"),
        leaveDate: new Date("2026-03-31T00:00:00.000Z"),
      },
    });
    const lapsed = await db.employee.create({
      data: {
        code: LAPSED,
        fullName: "Hợp đồng đã hết từ lúc đó tới nay",
        active: true,
        legalEntityId: entityId,
        hireDate: new Date("2026-01-01T00:00:00.000Z"),
      },
    });
    await db.employmentContract.create({
      data: {
        employeeId: lapsed.id,
        kind: "FIXED_TERM",
        // Over by now, and still the contract covering the day this filing
        // asks about.
        state: "ENDED",
        startDate: new Date("2026-01-01T00:00:00.000Z"),
        endDate: new Date("2026-08-31T00:00:00.000Z"),
      },
    });
    await db.employee.create({
      data: { code: ELSEWHERE, fullName: "Người của pháp nhân khác", active: true, legalEntityId: otherId },
    });
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("writes twenty seven columns under their form numbers", async () => {
    const rows = await extract();
    assert.equal(rows[0]?.length, COLUMNS);
    assert.equal(rows[0]?.[0], "(1) STT");
    assert.equal(rows[0]?.[COLUMNS - 1], "(27) Ghi chú");
  });

  it("keeps a person with no hire date in, and says what is missing", async () => {
    const row = rowOf(await extract(), "Không đủ hồ sơ");
    assert.ok(row, "a missing hire date must not drop somebody from a filing");
    assert.match(row[COLUMNS - 1] ?? "", /thiếu ngày vào làm/);
    assert.match(row[COLUMNS - 1] ?? "", /thiếu mã số BHXH/);
  });

  it("leaves out somebody who had already gone", async () => {
    assert.equal(rowOf(await extract(), "Đã nghỉ trước kỳ"), undefined);
  });

  it("carries the contract in force on the day, not the one in force now", async () => {
    const row = rowOf(await extract(), "Hợp đồng đã hết từ lúc đó tới nay");
    assert.ok(row);
    assert.equal(row[20], "2026-01-01", "fixed term start belongs in column 21");
    assert.equal(row[21], "2026-08-31", "fixed term end belongs in column 22");
    assert.doesNotMatch(row[COLUMNS - 1] ?? "", /chưa có hợp đồng/);
  });

  it("files one legal entity at a time", async () => {
    assert.equal(rowOf(await extract(), "Người của pháp nhân khác"), undefined);
  });
});
