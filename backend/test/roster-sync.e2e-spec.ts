import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { EnrollmentService } from "../src/modules/enrollment/enrollment.service.js";
import type { EnrollPayload } from "../src/common/generated/enroll_payload.js";

const DOOR_A = "e2e-door-a";
const DOOR_B = "e2e-door-b";
const DOORS = [DOOR_A, DOOR_B];
const CODE = "NV9200";
const EMBEDDING_BYTES = 512;

function capture(fill: number): string {
  return Buffer.alloc(EMBEDDING_BYTES, fill).toString("base64");
}

function report(deviceId: string, employeeId: number, fill: number, quality: number): EnrollPayload {
  return {
    op: "UPSERT",
    employeeId,
    templateIdx: 0,
    updatedAt: Date.now(),
    embedding: capture(fill),
    scale: 0.0078125,
    quality,
    embeddingVersion: "r1",
    deviceId,
    rosterVersion: 1,
  } as EnrollPayload;
}

describe("roster sync across doors (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let enrollment: EnrollmentService;
  let token = "";
  let employeeId = 0;

  async function sweep(): Promise<void> {
    await db.employee.deleteMany({ where: { code: CODE } });
    await db.device.deleteMany({ where: { id: { in: DOORS } } });
  }

  async function stateOf(deviceId: string): Promise<string> {
    const row = await db.deviceEnrollment.findUnique({
      where: { deviceId_employeeId: { deviceId, employeeId } },
    });
    return row?.state ?? "MISSING";
  }

  async function versionOf(deviceId: string): Promise<number> {
    const row = await db.device.findUniqueOrThrow({ where: { id: deviceId } });
    return row.rosterVersion;
  }

  before(async () => {
    const env = validateEnv();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    http = app.getHttpServer();
    db = app.get(PrismaService);
    enrollment = app.get(EnrollmentService);
    await sweep();

    const signedIn = await request(http)
      .post("/auth/login")
      .send({ email: "admin@kiosk.local", password: env.SEED_ADMIN_PASSWORD ?? "" });
    assert.equal(signedIn.status, 200, "admin could not sign in");
    token = signedIn.body.accessToken;

    for (const id of DOORS) {
      await db.device.create({ data: { id, name: id, status: "APPROVED" } });
    }
    const made = await db.employee.create({
      data: { code: CODE, fullName: "Một người hai cửa", active: true },
    });
    employeeId = made.id;
    const agreed = await request(http)
      .post("/biometric-consents")
      .set("Authorization", `Bearer ${token}`)
      .send({ employeeId, noticeVersion: "2026-01-v1", method: "PAPER" });
    assert.equal(agreed.status, 201);
    for (const id of DOORS) {
      const put = await request(http)
        .post("/enrollments")
        .set("Authorization", `Bearer ${token}`)
        .send({ deviceId: id, employeeId });
      assert.equal(put.status, 201, `could not assign to ${id}`);
    }
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("starts with both doors waiting for a face", async () => {
    assert.equal(await stateOf(DOOR_A), "ASSIGNED");
    assert.equal(await stateOf(DOOR_B), "ASSIGNED");
  });

  it("stops the other door asking once one of them has the face", async () => {
    const wasAt = await versionOf(DOOR_B);
    await enrollment.takeReport(DOOR_A, report(DOOR_A, employeeId, 0x33, 88));

    assert.equal(await stateOf(DOOR_A), "ENROLLED");
    assert.equal(await stateOf(DOOR_B), "ENROLLED", "the second door would ask for a face twice");
    assert.equal(await versionOf(DOOR_B) - wasAt, 1, "the other door has to be told, and counted");
  });

  it("keeps the better capture whichever one lands second", async () => {
    await enrollment.takeReport(DOOR_B, report(DOOR_B, employeeId, 0x44, 40));
    const held = await db.faceTemplate.findFirstOrThrow({ where: { employeeId } });
    assert.equal(held.quality, 88, "a blurrier capture arriving later must not win");
  });

  it("refuses a face from a door that was never given this person", async () => {
    const stranger = await db.device.create({
      data: { id: "e2e-door-x", name: "Cửa lạ", status: "APPROVED" },
    });
    await enrollment.takeReport(stranger.id, report(stranger.id, employeeId, 0x55, 99));
    const held = await db.faceTemplate.findFirstOrThrow({ where: { employeeId } });
    assert.equal(held.quality, 88, "a door with no assignment wrote biometric data");
    await db.device.delete({ where: { id: stranger.id } });
  });

  it("sends the whole roster again when a door reports an older version", async () => {
    const ahead = await versionOf(DOOR_B);
    const reached = await enrollment.converge(DOOR_B, ahead - 1);
    void reached;
    assert.equal(await versionOf(DOOR_B), ahead, "a resync does not move the counter on");
  });

  it("repairs a door whose counter stands behind its own roster", async () => {
    await db.device.update({ where: { id: DOOR_B }, data: { rosterVersion: 0 } });
    // The only repair path has to work from the state that needs repairing.
    const reached = await enrollment.resync(DOOR_B);
    assert.ok(reached >= 1, "a counter behind its roster sent a negative version and was refused");
    assert.equal(await versionOf(DOOR_B), reached);
  });
});
