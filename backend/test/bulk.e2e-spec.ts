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
const EFFECTIVE_FROM = "2029-01-01";
const REASON = "ANNUAL_REVIEW" as const;
// The note is what tells these rows apart from anything the seed wrote.
const NOTE = "e2e bulk raise";

describe("bulk writes (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let token = "";
  let population = 0;

  async function sweep(): Promise<void> {
    await db.compensationRecord.deleteMany({
      where: { effectiveFrom: new Date(EFFECTIVE_FROM), note: NOTE },
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
    population = await db.employee.count({ where: { active: true } });
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("raises the whole company in one call, and says how long it held", async () => {
    const started = Date.now();
    const res = await request(http)
      .post("/compensation/bulk")
      .set("Authorization", `Bearer ${token}`)
      .send({ effectiveFrom: EFFECTIVE_FROM, percentBp: RAISE_BP, reason: REASON, note: NOTE });
    const took = Date.now() - started;
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.ok(res.body.written > 0, "nobody was raised");
    console.log(`bulk raise: ${res.body.written} of ${population} in ${took} ms`);
  });

  it("writes nothing extra when the same raise runs again", async () => {
    const before = await db.compensationRecord.count({
      where: { effectiveFrom: new Date(EFFECTIVE_FROM), note: NOTE },
    });
    const res = await request(http)
      .post("/compensation/bulk")
      .set("Authorization", `Bearer ${token}`)
      .send({ effectiveFrom: EFFECTIVE_FROM, percentBp: RAISE_BP, reason: REASON, note: NOTE });
    assert.equal(res.status, 201);
    const after = await db.compensationRecord.count({
      where: { effectiveFrom: new Date(EFFECTIVE_FROM), note: NOTE },
    });
    assert.equal(after, before, "a second run of the same raise wrote a second set of rows");
  });
});
