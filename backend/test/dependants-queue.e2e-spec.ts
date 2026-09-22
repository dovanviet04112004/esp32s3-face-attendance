import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { AuthService } from "../src/modules/auth/auth.service.js";

const HOLDER = "E2EDQ01";
const WAITING = 3;

interface Queue {
  rows: { id: string }[];
  total: number;
  totalIsExact: boolean;
}

describe("the dependants queue says how much is waiting (e2e)", () => {
  let app: INestApplication;
  let db: PrismaService;
  let token = "";
  let holderId = 0;

  async function sweep(): Promise<void> {
    await db.employee.deleteMany({ where: { code: HOLDER } });
  }

  before(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    db = app.get(PrismaService);
    await sweep();

    const made = await db.employee.create({
      data: { code: HOLDER, fullName: "Giữ người phụ thuộc", active: true },
    });
    holderId = made.id;
    await db.dependent.createMany({
      data: Array.from({ length: WAITING }, (unused, at) => ({
        employeeId: holderId,
        fullName: `Người phụ thuộc ${at}`,
        relation: "CHILD" as const,
        fromMonth: new Date(Date.UTC(2039, at, 1)),
        state: "PENDING" as const,
      })),
    });
    token = (
      await app
        .get(AuthService)
        .signIn("admin@kiosk.local", validateEnv().SEED_ADMIN_PASSWORD ?? "", {})
    ).accessToken;
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("answers with rows beside a count, not a bare list", async () => {
    const res = await request(app.getHttpServer())
      .get("/dependents?state=PENDING")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.equal(Array.isArray(res.body), false, "a bare list carries no count to read");
    const page = res.body as Queue;
    assert.equal(typeof page.total, "number");
    assert.equal(page.totalIsExact, true);
  });

  it("counts every registration waiting, not only the ones on this page", async () => {
    const res = await request(app.getHttpServer())
      .get("/dependents?state=PENDING")
      .set("Authorization", `Bearer ${token}`);
    const page = res.body as Queue;
    const mine = await db.dependent.count({ where: { employeeId: holderId, state: "PENDING" } });
    assert.equal(mine, WAITING, "the fixture lost the rows this suite counts");
    assert.ok(
      page.total >= WAITING,
      `the queue reported ${page.total} with ${WAITING} of this suite's own waiting`,
    );
    assert.ok(page.total >= page.rows.length, "a count smaller than its own page is not a count");
  });
});
