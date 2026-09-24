import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { RedisService } from "../src/database/redis.service.js";
import { HealthController } from "../src/modules/health/health.controller.js";

describe("health (e2e)", () => {
  let app: INestApplication;

  before(async () => {
    void validateEnv();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
  });

  after(async () => {
    await app.close();
  });

  it("answers ok without a login while Postgres and Redis are up", async () => {
    const res = await request(app.getHttpServer()).get("/health");
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { status: "ok" });
  });

  it("gives up on a Redis that never answers and says so", async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        { provide: PrismaService, useValue: { $queryRaw: async () => [{ "?column?": 1 }] } },
        { provide: RedisService, useValue: { client: { ping: () => new Promise(() => {}) } } },
      ],
    }).compile();
    const stalled = moduleRef.createNestApplication();
    await stalled.init();
    const started = Date.now();
    const res = await request(stalled.getHttpServer()).get("/health");
    await stalled.close();
    assert.equal(res.status, 503);
    assert.ok(Date.now() - started < 5000, "the probe must stop waiting on its own");
  });
});
