import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { EnrollmentService } from "../src/modules/enrollment/enrollment.service.js";
import { seedEntityId } from "./fixtures.js";

const LIVE = "recog-e2e93000000000a1";
const DEAD = "recog-e2e93000000000d0";
const DOOR = "e2e-door-live-model";
const UNNAMED = "e2e-door-unnamed-model";
const CODES = ["NV9301", "NV9302"];

// Alone: the nightly erase reads every approved kiosk and every face set in the table.
describe("the nightly erase of face sets no kiosk runs (e2e)", () => {
  let app: INestApplication;
  let db: PrismaService;
  let enrollment: EnrollmentService;
  const ids: number[] = [];

  async function sweep(): Promise<void> {
    await db.employee.deleteMany({ where: { code: { in: CODES } } });
    await db.device.deleteMany({ where: { id: { in: [DOOR, UNNAMED] } } });
  }

  async function modelsOf(employeeId: number): Promise<(string | null)[]> {
    const rows = await db.faceTemplate.findMany({ where: { employeeId }, orderBy: [{ embeddingVersion: "asc" }, { templateIdx: "asc" }] });
    return rows.map((row) => row.embeddingVersion);
  }

  before(async () => {
    void validateEnv();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    db = app.get(PrismaService);
    enrollment = app.get(EnrollmentService);
    await sweep();
    const entityId = await seedEntityId(db);
    await db.device.create({ data: { id: DOOR, name: DOOR, status: "APPROVED", embeddingVersion: LIVE } });
    for (const code of CODES) {
      const one = await db.employee.create({ data: { code, fullName: `Người ${code}`, active: true, legalEntityId: entityId } });
      ids.push(one.id);
    }
    const sample = { embedding: Buffer.alloc(8), scale: 0.01, capturedAt: new Date() };
    await db.faceTemplate.createMany({
      data: [
        { employeeId: ids[0], embeddingVersion: LIVE, templateIdx: 0, ...sample },
        { employeeId: ids[0], embeddingVersion: DEAD, templateIdx: 0, ...sample },
        { employeeId: ids[1], embeddingVersion: DEAD, templateIdx: 0, ...sample },
        { employeeId: ids[1], embeddingVersion: null, templateIdx: 1, ...sample },
      ],
    });
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("erases nothing while an approved kiosk has not named its model", async () => {
    await db.device.create({ data: { id: UNNAMED, name: UNNAMED, status: "APPROVED" } });
    assert.deepEqual(await enrollment.dropUnusedSets(), { people: 0, templates: 0 });
    assert.deepEqual(await modelsOf(ids[1]), [DEAD, null]);
    await db.device.delete({ where: { id: UNNAMED } });
  });

  it("erases the sets of models no approved kiosk runs, keeps the rest, and audits each person", async () => {
    const done = await enrollment.dropUnusedSets();
    assert.ok(done.templates >= 3, JSON.stringify(done));
    assert.deepEqual(await modelsOf(ids[0]), [LIVE], "a set a kiosk runs went, or a dead one stayed");
    assert.deepEqual(await modelsOf(ids[1]), [], "a set of a model nobody runs outlived the night");
    for (const employeeId of ids) {
      const logged = await db.auditLog.count({ where: { action: "biometric.erase", subjectId: String(employeeId) } });
      assert.equal(logged, 1, `the erase of ${employeeId} left no trail`);
    }
    assert.deepEqual(await enrollment.dropUnusedSets(), { people: 0, templates: 0 }, "a second night found more to erase");
  });
});
