import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";

const RAISE_BP = 100;
const BASE_SALARY = "20000000";
const EFFECTIVE_FROM = "2029-01-01";
const HIRED_FROM = "2028-01-01";
const REASON = "ANNUAL_REVIEW" as const;
// Its own people rather than the whole company: the company-wide figure is a
// measurement, and running one here starves the suites that watch a clock.
const CODES = ["NV9131B", "NV9132B", "NV9133B"];

describe("bulk raise (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let token = "";
  let employeeIds: number[] = [];

  async function sweep(): Promise<void> {
    await db.employee.deleteMany({ where: { code: { in: CODES } } });
  }

  function raise(): Promise<request.Response> {
    return request(http)
      .post("/compensation/bulk")
      .set("Authorization", `Bearer ${token}`)
      .send({ effectiveFrom: EFFECTIVE_FROM, percentBp: RAISE_BP, reason: REASON, employeeIds });
  }

  function written(): Promise<number> {
    return db.compensationRecord.count({
      where: { employeeId: { in: employeeIds }, effectiveFrom: new Date(EFFECTIVE_FROM) },
    });
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

    const asAdmin = await request(http)
      .post("/auth/login")
      .send({ email: "admin@kiosk.local", password: env.SEED_ADMIN_PASSWORD ?? "" });
    assert.equal(asAdmin.status, 200, "admin could not sign in");
    token = asAdmin.body.accessToken;

    const template = await db.employee.findFirstOrThrow({ where: { active: true } });
    employeeIds = [];
    for (const code of CODES) {
      const made = await db.employee.create({
        data: {
          code,
          fullName: `Thử nâng lương ${code}`,
          departmentId: template.departmentId,
          legalEntityId: template.legalEntityId,
        },
      });
      employeeIds.push(made.id);
      await db.compensationRecord.create({
        data: {
          employeeId: made.id,
          effectiveFrom: new Date(HIRED_FROM),
          baseSalary: BASE_SALARY,
          insuranceSalary: BASE_SALARY,
        },
      });
    }
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("writes one dated record per person", async () => {
    const res = await raise();
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.written, CODES.length);
    assert.equal(await written(), CODES.length);
  });

  it("raises by the rate it was given, leaving the old figure in place", async () => {
    const rows = await db.compensationRecord.findMany({
      where: { employeeId: { in: employeeIds }, effectiveFrom: new Date(EFFECTIVE_FROM) },
    });
    const wanted = (BigInt(BASE_SALARY) * BigInt(10_000 + RAISE_BP)) / 10_000n;
    for (const row of rows) {
      assert.equal(row.baseSalary.toFixed(0), wanted.toString());
    }
    const older = await db.compensationRecord.count({
      where: { employeeId: { in: employeeIds }, effectiveFrom: new Date(HIRED_FROM) },
    });
    assert.equal(older, CODES.length, "the raise overwrote what it should have appended to");
  });

  it("writes nothing extra when the same raise runs again", async () => {
    assert.equal((await raise()).status, 201);
    assert.equal(
      await written(),
      CODES.length,
      "a second run of the same raise wrote a second set of rows",
    );
  });
});
