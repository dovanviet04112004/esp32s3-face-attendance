import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";

// A month with no seeded attendance, so the unpaid-day rule only sees what
// this suite writes.
const FROM = "2026-04-01";
const TO = "2026-04-30";

const SEED_ENTITY = "DEFAULT";
const JOINED = "NV9701";
const GONE = "NV9702";
const RAISED = "NV9703";
const CUT = "NV9704";
const ABSENT = "NV9705";
const MADE_CODES = [JOINED, GONE, RAISED, CUT, ABSENT];

interface Change {
  code: string;
  reason: string;
  fromSalary: string | null;
  toSalary: string | null;
}

interface Changes {
  unpaidDayThreshold: number;
  increases: Change[];
  decreases: Change[];
  adjustments: Change[];
}

describe("insurance changes (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let token = "";
  let entityId = "";
  let held: Changes;

  async function sweep(): Promise<void> {
    const made = await db.employee.findMany({
      where: { code: { in: MADE_CODES } },
      select: { id: true },
    });
    await db.attendanceDay.deleteMany({ where: { employeeId: { in: made.map((one) => one.id) } } });
    await db.employee.deleteMany({ where: { code: { in: MADE_CODES } } });
  }

  function only(rows: Change[], code: string): Change | undefined {
    return rows.find((one) => one.code === code);
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

    // Named, not whichever entity turns up first: only this one carries the
    // seeded policy this report reads its threshold from.
    const holder = await db.legalEntity.findUniqueOrThrow({ where: { code: SEED_ENTITY } });
    entityId = holder.id;

    async function make(code: string, over: Record<string, unknown> = {}): Promise<number> {
      const made = await db.employee.create({
        data: { code, fullName: `Biến động ${code}`, active: true, legalEntityId: entityId, ...over },
      });
      return made.id;
    }

    // Hired inside the window, and given a first salary the same day: that is
    // one filing, not a rise on top of it.
    const joined = await make(JOINED, { hireDate: new Date("2026-04-07T00:00:00.000Z") });
    await db.compensationRecord.create({
      data: {
        employeeId: joined,
        effectiveFrom: new Date("2026-04-07T00:00:00.000Z"),
        baseSalary: "12000000",
        insuranceSalary: "12000000",
      },
    });

    await make(GONE, {
      hireDate: new Date("2025-01-01T00:00:00.000Z"),
      leaveDate: new Date("2026-04-20T00:00:00.000Z"),
      active: false,
    });

    for (const [code, before, after] of [
      [RAISED, "10000000", "14000000"],
      [CUT, "18000000", "16000000"],
    ] as const) {
      const who = await make(code, { hireDate: new Date("2025-01-01T00:00:00.000Z") });
      await db.compensationRecord.create({
        data: {
          employeeId: who,
          effectiveFrom: new Date("2025-01-01T00:00:00.000Z"),
          baseSalary: before,
          insuranceSalary: before,
        },
      });
      await db.compensationRecord.create({
        data: {
          employeeId: who,
          effectiveFrom: new Date("2026-04-10T00:00:00.000Z"),
          baseSalary: after,
          insuranceSalary: after,
        },
      });
    }

    const idle = await make(ABSENT, { hireDate: new Date("2025-01-01T00:00:00.000Z") });
    await db.attendanceDay.createMany({
      data: Array.from({ length: 15 }, (unused, at) => ({
        employeeId: idle,
        date: new Date(Date.UTC(2026, 3, at + 1)),
        state: "ABSENT" as const,
      })),
    });

    const res = await request(http)
      .get(`/reports/insurance-changes?legalEntityId=${entityId}&from=${FROM}&to=${TO}`)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    held = res.body as Changes;
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("reports somebody who started as an increase", () => {
    assert.equal(only(held.increases, JOINED)?.reason, "HIRED");
  });

  it("does not bill a new hire's first salary as a rise as well", () => {
    assert.equal(only(held.adjustments, JOINED), undefined);
  });

  it("reports somebody who left as a decrease", () => {
    assert.equal(only(held.decreases, GONE)?.reason, "LEFT");
  });

  it("tells a rise from a cut, and carries both figures", () => {
    const up = only(held.adjustments, RAISED);
    assert.equal(up?.reason, "SALARY_UP");
    assert.equal(up?.fromSalary, "10000000");
    assert.equal(up?.toSalary, "14000000");
    assert.equal(only(held.adjustments, CUT)?.reason, "SALARY_DOWN");
  });

  it("stops the contribution once the unpaid days reach the policy's count", () => {
    assert.equal(held.unpaidDayThreshold, 14);
    assert.equal(only(held.decreases, ABSENT)?.reason, "UNPAID_14");
  });
});
