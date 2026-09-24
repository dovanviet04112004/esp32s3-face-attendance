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

// Every sample of one capture session carries the session's start (KEHOACH 7.5).
function report(deviceId: string, employeeId: number, fill: number, session: number, templateIdx = 0): EnrollPayload {
  return {
    op: "UPSERT",
    employeeId,
    templateIdx,
    updatedAt: session,
    embedding: capture(fill),
    scale: 0.0078125,
    quality: 255,
    embeddingVersion: "r1",
    deviceId,
    rosterVersion: 1,
  } as EnrollPayload;
}

function ask(deviceId: string, employeeId: number, op: "RETAKE" | "DELETE_EMPLOYEE"): EnrollPayload {
  return { op, employeeId, templateIdx: 0, updatedAt: Date.now(), deviceId } as EnrollPayload;
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

  async function samples(): Promise<{ idx: number; at: number }[]> {
    const rows = await db.faceTemplate.findMany({ where: { employeeId }, orderBy: { templateIdx: "asc" } });
    return rows.map((row) => ({ idx: row.templateIdx, at: row.capturedAt.getTime() }));
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

  const FIRST = 1_790_000_000_000;
  const SECOND = FIRST + 60_000;
  const RETAKEN = FIRST + 120_000;

  it("stops the other door asking once one of them has the face", async () => {
    const wasAt = await versionOf(DOOR_B);
    await enrollment.takeReport(DOOR_A, report(DOOR_A, employeeId, 0x33, FIRST));

    assert.equal(await stateOf(DOOR_A), "ENROLLED");
    assert.equal(await stateOf(DOOR_B), "ENROLLED", "the second door would ask for a face twice");
    assert.equal(await versionOf(DOOR_B) - wasAt, 1, "the other door has to be told, and counted");
  });

  it("takes the rest of the session held, and a repeat of it only once", async () => {
    await enrollment.takeReport(DOOR_A, report(DOOR_A, employeeId, 0x33, FIRST, 1));
    await enrollment.takeReport(DOOR_A, report(DOOR_A, employeeId, 0x33, FIRST, 1));
    assert.deepEqual((await samples()).map((one) => [one.idx, one.at]), [[0, FIRST], [1, FIRST]]);
  });

  it("turns away the other door's session once the first one is held", async () => {
    const wasAt = await versionOf(DOOR_B);
    await enrollment.takeReport(DOOR_B, report(DOOR_B, employeeId, 0x44, SECOND));
    assert.deepEqual((await samples()).map((one) => one.at), [FIRST, FIRST], "a later session overwrote the held one");
    // One drop, then each held sample: the door ends with exactly what the server keeps.
    assert.equal(await versionOf(DOOR_B) - wasAt, 3, "the refused door was not brought back to the held samples");
  });

  it("refuses a face from a door that was never given this person", async () => {
    const stranger = await db.device.create({
      data: { id: "e2e-door-x", name: "Cửa lạ", status: "APPROVED" },
    });
    await enrollment.takeReport(stranger.id, report(stranger.id, employeeId, 0x55, SECOND));
    assert.deepEqual((await samples()).map((one) => one.at), [FIRST, FIRST], "a door with no assignment wrote biometric data");
    await db.device.delete({ where: { id: stranger.id } });
  });

  it("puts a held face up for retake from the dashboard without dropping it", async () => {
    const put = await request(http)
      .post("/enrollments")
      .set("Authorization", `Bearer ${token}`)
      .send({ deviceId: DOOR_B, employeeId });
    assert.equal(put.status, 201);
    assert.equal(await stateOf(DOOR_B), "RETAKE", "a held face was sent back to waiting for one");
    assert.equal((await samples()).length, 2, "asking for a retake threw the old samples away");
  });

  it("puts a held face up for retake when the kiosk asks", async () => {
    const wasAt = await versionOf(DOOR_A);
    await enrollment.takeReport(DOOR_A, ask(DOOR_A, employeeId, "RETAKE"));
    assert.equal(await stateOf(DOOR_A), "RETAKE");
    assert.equal(await versionOf(DOOR_A) - wasAt, 1, "the kiosk was not told the retake stands");
  });

  it("lets the new session replace every old sample on every door", async () => {
    const wasAt = await versionOf(DOOR_B);
    await enrollment.takeReport(DOOR_A, report(DOOR_A, employeeId, 0x66, RETAKEN, 3));
    assert.deepEqual((await samples()).map((one) => [one.idx, one.at]), [[3, RETAKEN]], "an old sample outlived the retake");
    assert.equal(await stateOf(DOOR_A), "ENROLLED");
    assert.equal(await stateOf(DOOR_B), "ENROLLED", "the other door still waits for a face it has been sent");
    assert.equal(await versionOf(DOOR_B) - wasAt, 2, "the other door kept its old samples");
  });

  it("takes a kiosk's remove request and keeps the samples other doors use", async () => {
    await enrollment.takeReport(DOOR_B, ask(DOOR_B, employeeId, "DELETE_EMPLOYEE"));
    assert.equal(await stateOf(DOOR_B), "REVOKED");
    assert.equal((await samples()).length, 1, "removing a person from one door erased their face everywhere");
    const logged = await db.auditLog.count({ where: { action: "enrollment.remove", subjectId: String(employeeId) } });
    assert.equal(logged, 1, "a kiosk's removal left no trace");
  });

  it("does not hand a door its removed person back when another door captures", async () => {
    await enrollment.takeReport(DOOR_A, ask(DOOR_A, employeeId, "RETAKE"));
    const wasAt = await versionOf(DOOR_B);
    await enrollment.takeReport(DOOR_A, report(DOOR_A, employeeId, 0x77, RETAKEN + 60_000, 0));
    assert.equal(await stateOf(DOOR_B), "REVOKED");
    assert.equal(await versionOf(DOOR_B), wasAt, "a revoked door was sent the face again");
  });

  it("tells the desk where the person stands on each kiosk, leaving out removed ones", async () => {
    const res = await request(http)
      .get(`/enrollments/employees/${employeeId}`)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    assert.deepEqual(
      (res.body as { id: string; state: string }[]).map((row) => [row.id, row.state]),
      [[DOOR_A, "ENROLLED"]],
    );
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
