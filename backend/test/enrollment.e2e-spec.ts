import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, describe, it, mock } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { TOPICS } from "../src/common/generated/topics.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { AttendanceService } from "../src/modules/attendance/attendance.service.js";
import { EnrollmentService } from "../src/modules/enrollment/enrollment.service.js";
import { openTemplate } from "../src/modules/enrollment/template-crypto.js";
import { MqttService } from "../src/modules/mqtt/mqtt.service.js";
import { publishAsKiosk, seedEntityId } from "./fixtures.js";

const DEVICE_ID = "kiosk-e2e-enroll";
const OFF_FLEET = "kiosk-e2e-enroll-off";
const PEER = "kiosk-e2e-enroll-peer";
const GONE = "kiosk-e2e-enroll-gone";
const DOORS = [DEVICE_ID, OFF_FLEET, PEER, GONE];
const MODEL = "recog-f77969e342ab10b4";
const CODE = "NV9100";
const OUTSIDER = "NV9101";
const SPREAD = "NV9102";
const TWICE = "NV9103";
const AUDITED = "NV9104";
// Wider than the half second the WSL wall clock steps back, so the punch falls between the two removals.
const REMOVE_GAP_MS = 2000;
const BETWEEN_MS = 500;
const RACERS = ["NV9111", "NV9112", "NV9113", "NV9114", "NV9115", "NV9116"];
const EMBEDDING_BYTES = 512;
const SETTLE_MS = 15000;
const SETTLE_POLL_MS = 50;

function embedding(): string {
  const raw = Buffer.alloc(EMBEDDING_BYTES);
  for (let i = 0; i < EMBEDDING_BYTES; i += 1) {
    raw[i] = (i * 7) % 256;
  }
  return raw.toString("base64");
}

describe("enrollment (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let admin = "";
  let employeeId = 0;
  let entityId = "";
  const sample = embedding();

  async function sweep(): Promise<void> {
    await db.deviceEnrollment.deleteMany({ where: { deviceId: { in: DOORS } } });
    await db.faceTemplate.deleteMany({ where: { employee: { code: { in: [CODE, SPREAD] } } } });
    await db.employee.deleteMany({ where: { code: { in: [CODE, OUTSIDER, SPREAD, TWICE, AUDITED, ...RACERS] } } });
    await db.device.deleteMany({ where: { id: { in: DOORS } } });
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

    const login = await request(http)
      .post("/auth/login")
      .send({ email: "admin@kiosk.local", password: env.SEED_ADMIN_PASSWORD });
    admin = login.body.accessToken;

    await db.device.create({ data: { id: DEVICE_ID, status: "APPROVED" } });
    entityId = await seedEntityId(db);
    const made = await request(http)
      .post("/employees")
      .set("Authorization", `Bearer ${admin}`)
      .send({ code: CODE, fullName: "Phạm Thị D", legalEntityId: entityId });
    employeeId = made.body.id;
    await request(http)
      .post("/biometric-consents")
      .set("Authorization", `Bearer ${admin}`)
      .send({ employeeId, method: "PAPER" });
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("refuses to enrol a face nobody agreed to hand over", async () => {
    const other = await request(http)
      .post("/employees")
      .set("Authorization", `Bearer ${admin}`)
      .send({ code: `${CODE}X`, fullName: "Chưa đồng ý", legalEntityId: entityId });
    const res = await request(http)
      .post("/enrollments")
      .set("Authorization", `Bearer ${admin}`)
      .send({ deviceId: DEVICE_ID, employeeId: other.body.id });
    assert.equal(res.status, 403);
    assert.equal(res.body.message, "BIOMETRIC_CONSENT_MISSING");
    await db.employee.delete({ where: { id: other.body.id } });
  });

  it("puts nobody on a kiosk outside the fleet and sends it no roster", async () => {
    const outsider = await db.employee.create({
      data: { code: OUTSIDER, fullName: "Ngoài đội", active: true, legalEntityId: entityId },
    });
    await db.biometricConsent.create({ data: { employeeId: outsider.id, noticeVersion: "e2e", method: "PAPER" } });
    for (const status of ["REVOKED", "PENDING"] as const) {
      await db.device.upsert({ where: { id: OFF_FLEET }, update: { status }, create: { id: OFF_FLEET, status } });
      const held = await db.device.findUniqueOrThrow({ where: { id: OFF_FLEET } });
      const assigned = await request(http)
        .post("/enrollments")
        .set("Authorization", `Bearer ${admin}`)
        .send({ deviceId: OFF_FLEET, employeeId: outsider.id });
      const resent = await request(http).post(`/enrollments/${OFF_FLEET}/resync`).set("Authorization", `Bearer ${admin}`);
      for (const res of [assigned, resent]) {
        assert.equal(res.status, 409, `${status}: ${JSON.stringify(res.body)}`);
        assert.equal(res.body.message, "DEVICE_NOT_APPROVED");
      }
      const now = await db.device.findUniqueOrThrow({ where: { id: OFF_FLEET } });
      assert.equal(now.rosterVersion, held.rosterVersion, `a ${status} kiosk was sent a roster`);
      assert.equal(await db.deviceEnrollment.count({ where: { deviceId: OFF_FLEET } }), 0);
    }
  });

  it("assigns a person to a kiosk and moves the roster on by one", async () => {
    const before = await db.device.findUniqueOrThrow({ where: { id: DEVICE_ID } });
    const res = await request(http)
      .post("/enrollments")
      .set("Authorization", `Bearer ${admin}`)
      .send({ deviceId: DEVICE_ID, employeeId });
    assert.equal(res.status, 201);
    assert.equal(res.body.state, "ASSIGNED");

    const now = await db.device.findUniqueOrThrow({ where: { id: DEVICE_ID } });
    assert.equal(now.rosterVersion, before.rosterVersion + 1);
  });

  // Waits on the round trip's last write: the template row lands first, the pair turns ENROLLED after it.
  async function settled() {
    for (let waited = 0; waited < SETTLE_MS; waited += SETTLE_POLL_MS) {
      const [row, pair] = await Promise.all([
        db.faceTemplate.findFirst({ where: { employeeId, templateIdx: 0 } }),
        db.deviceEnrollment.findUnique({
          where: { deviceId_employeeId: { deviceId: DEVICE_ID, employeeId } },
        }),
      ]);
      if (row && pair?.state === "ENROLLED") {
        return { row, pair };
      }
      await sleep(SETTLE_POLL_MS);
    }
    throw new Error(`the enrolment did not land in ${SETTLE_MS} ms`);
  }

  it("stores what the kiosk reports, sealed rather than in the clear", async () => {
    await publishAsKiosk(TOPICS.enroll_report.build(DEVICE_ID), {
      op: "UPSERT",
      employeeId,
      templateIdx: 0,
      updatedAt: Date.now(),
      embedding: sample,
      scale: 0.0125,
      embeddingVersion: "recog-f77969e342ab10b4",
    });
    const { row: held, pair } = await settled();
    const stored = Buffer.from(held.embedding);
    assert.notEqual(stored.toString("base64"), sample, "the template was stored in the clear");
    assert.ok(stored.length > EMBEDDING_BYTES, "a sealed template carries an iv and a tag");

    const opened = openTemplate(held.embedding, validateEnv().TEMPLATE_ENCRYPTION_KEY);
    assert.equal(opened.toString("base64"), sample);

    assert.equal(pair.state, "ENROLLED");
  });

  it("resends the whole roster on demand, every message inside its contract", async () => {
    const res = await request(http)
      .post(`/enrollments/${DEVICE_ID}/resync`)
      .set("Authorization", `Bearer ${admin}`);
    assert.equal(res.status, 201);
    assert.ok(res.body.rosterVersion >= 1);
  });

  it("resyncs a kiosk whose heartbeat reports an older roster", async () => {
    const enrollment = app.get(EnrollmentService);
    const mqtt = app.get(MqttService);
    const sent: { op: string; rosterVersion?: number }[] = [];
    const spy = mock.method(mqtt, "publishDown", async (...args: unknown[]) => {
      sent.push(args[2] as { op: string; rosterVersion?: number });
    });

    const device = await db.device.findUniqueOrThrow({ where: { id: DEVICE_ID } });
    await enrollment.converge(DEVICE_ID, 0);
    spy.mock.restore();

    assert.ok(sent.length >= 1, "a kiosk left behind was not resynced");
    assert.equal(sent[0].op, "REPLACE_ALL", "convergence has to clear before it fills");
    assert.equal(sent[0].rosterVersion, device.rosterVersion + 1, "the run reused numbers already sent");
    const last = sent[sent.length - 1];
    const after = await db.device.findUniqueOrThrow({ where: { id: DEVICE_ID } });
    assert.equal(last.rosterVersion, after.rosterVersion, "the run must land on the target");
  });

  it("leaves a kiosk alone when its heartbeat is already level", async () => {
    const enrollment = app.get(EnrollmentService);
    const mqtt = app.get(MqttService);
    let calls = 0;
    const spy = mock.method(mqtt, "publishDown", async () => {
      calls += 1;
    });

    const device = await db.device.findUniqueOrThrow({ where: { id: DEVICE_ID } });
    await enrollment.converge(DEVICE_ID, device.rosterVersion);
    spy.mock.restore();

    assert.equal(calls, 0, "a kiosk in step was sent traffic anyway");
  });

  it("withdraws a person and moves the roster on again", async () => {
    const before = await db.device.findUniqueOrThrow({ where: { id: DEVICE_ID } });
    const res = await request(http)
      .delete(`/enrollments/${DEVICE_ID}/${employeeId}`)
      .set("Authorization", `Bearer ${admin}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.state, "REVOKED");

    const now = await db.device.findUniqueOrThrow({ where: { id: DEVICE_ID } });
    assert.equal(now.rosterVersion, before.rosterVersion + 1);
  });

  it("answers ENROLLMENT_NOT_FOUND for a person the kiosk was never given", async () => {
    const before = await db.device.findUniqueOrThrow({ where: { id: DEVICE_ID } });
    const res = await request(http)
      .delete(`/enrollments/${DEVICE_ID}/${2_000_000_000}`)
      .set("Authorization", `Bearer ${admin}`);
    assert.equal(res.status, 404);
    assert.equal(res.body.message, "ENROLLMENT_NOT_FOUND");

    const now = await db.device.findUniqueOrThrow({ where: { id: DEVICE_ID } });
    assert.equal(now.rosterVersion, before.rosterVersion, "a refused withdrawal moved the roster");
  });

  it("counts every enrolment when six land at once", async () => {
    const template = await db.employee.findFirstOrThrow({ where: { active: true } });
    const made = await Promise.all(
      RACERS.map((code) =>
        db.employee.create({
          data: { code, fullName: `Đăng ký đua ${code}`, active: true, legalEntityId: template.legalEntityId },
        }),
      ),
    );
    await Promise.all(
      made.map((one) =>
        request(http)
          .post("/biometric-consents")
          .set("Authorization", `Bearer ${admin}`)
          .send({ employeeId: one.id, method: "PAPER" }),
      ),
    );

    const before = await db.device.findUniqueOrThrow({ where: { id: DEVICE_ID } });
    const answers = await Promise.all(
      made.map((one) =>
        request(http)
          .post("/enrollments")
          .set("Authorization", `Bearer ${admin}`)
          .send({ deviceId: DEVICE_ID, employeeId: one.id }),
      ),
    );
    assert.deepEqual(
      answers.map((one) => one.status),
      made.map(() => 201),
    );

    // The version a kiosk must reach counts every change; a counter read here and written back loses some.
    const after = await db.device.findUniqueOrThrow({ where: { id: DEVICE_ID } });
    assert.equal(after.rosterVersion - before.rosterVersion, made.length);
  });

  it("stamps the notice the server serves and refuses one a client names", async () => {
    const racer = await db.employee.findUniqueOrThrow({ where: { code: RACERS[0] } });
    const named = await request(http)
      .post("/biometric-consents")
      .set("Authorization", `Bearer ${admin}`)
      .send({ employeeId: racer.id, noticeVersion: "made-up", method: "PAPER" });
    assert.equal(named.status, 400);
    const held = await db.biometricConsent.findFirstOrThrow({
      where: { employeeId: racer.id, state: "GRANTED" },
    });
    assert.equal(held.noticeVersion, validateEnv().BIOMETRIC_NOTICE_VERSION);
  });

  it("erases on withdrawal even while no kiosk can be reached, and erases again when asked again", async () => {
    const racer = await db.employee.findUniqueOrThrow({ where: { code: RACERS[1] } });
    await db.faceTemplate.create({
      data: { employeeId: racer.id, templateIdx: 0, embedding: Buffer.alloc(8), scale: 0.01, capturedAt: new Date() },
    });
    const mqtt = app.get(MqttService);
    const down = mock.method(mqtt, "publishDown", async () => {
      throw new Error("no broker");
    });
    const first = await request(http)
      .post(`/biometric-consents/${racer.id}/withdraw`)
      .set("Authorization", `Bearer ${admin}`);
    down.mock.restore();
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.consent.state, "WITHDRAWN");
    assert.equal(await db.faceTemplate.count({ where: { employeeId: racer.id } }), 0);
    const pair = await db.deviceEnrollment.findUniqueOrThrow({
      where: { deviceId_employeeId: { deviceId: DEVICE_ID, employeeId: racer.id } },
    });
    assert.equal(pair.state, "REVOKED");

    const again = await request(http)
      .post(`/biometric-consents/${racer.id}/withdraw`)
      .set("Authorization", `Bearer ${admin}`);
    assert.equal(again.status, 201, "a retry must finish the erase, not refuse it");
    assert.ok(again.body.devices >= 1);
  });

  it("keeps no face a kiosk captures once consent is gone", async () => {
    const racer = await db.employee.findUniqueOrThrow({ where: { code: RACERS[1] } });
    const mqtt = app.get(MqttService);
    const sent: { op: string }[] = [];
    const down = mock.method(mqtt, "publishDown", async (...args: unknown[]) => {
      sent.push(args[2] as { op: string });
    });
    await app.get(EnrollmentService).takeReport(DEVICE_ID, {
      op: "UPSERT",
      employeeId: racer.id,
      templateIdx: 0,
      updatedAt: Date.now(),
      embedding: sample,
      scale: 0.0125,
      rosterVersion: 1,
      deviceId: DEVICE_ID,
    });
    down.mock.restore();
    assert.equal(await db.faceTemplate.count({ where: { employeeId: racer.id } }), 0);
    assert.ok(sent.some((one) => one.op === "DELETE_EMPLOYEE"), "the kiosk was not told to drop the face");
  });

  it("hands a captured face to the other kiosks holding the person, never to one revoked since", async () => {
    const person = await db.employee.create({
      data: { code: SPREAD, fullName: "Lan mẫu", active: true, legalEntityId: entityId },
    });
    await db.biometricConsent.create({ data: { employeeId: person.id, noticeVersion: "e2e", method: "PAPER" } });
    for (const id of [PEER, GONE]) {
      await db.device.create({ data: { id, status: "APPROVED", embeddingVersion: MODEL } });
    }
    const enrollment = app.get(EnrollmentService);
    const sent: string[] = [];
    const down = mock.method(app.get(MqttService), "publishDown", async (_name: string, to: string) => {
      sent.push(to);
    });
    const versionOf = async (id: string) => (await db.device.findUniqueOrThrow({ where: { id } })).rosterVersion;
    const readFor = (deviceId: string) =>
      db.auditLog.count({
        where: { action: "biometric.read", subjectId: String(person.id), meta: { path: ["deviceId"], equals: deviceId } },
      });
    try {
      for (const door of [DEVICE_ID, PEER, GONE]) {
        await enrollment.assign(door, person.id);
      }
      const revoked = await request(http).post(`/devices/${GONE}/revoke`).set("Authorization", `Bearer ${admin}`);
      assert.equal(revoked.status, 201, JSON.stringify(revoked.body));
      const [peerAt, goneAt] = [await versionOf(PEER), await versionOf(GONE)];
      sent.length = 0;
      await enrollment.takeReport(DEVICE_ID, {
        op: "UPSERT",
        employeeId: person.id,
        templateIdx: 0,
        updatedAt: Date.now(),
        embedding: sample,
        scale: 0.0125,
        embeddingVersion: MODEL,
        rosterVersion: 1,
        deviceId: DEVICE_ID,
      });
      assert.equal(await versionOf(PEER), peerAt + 1, "a kiosk holding the person was not handed the face");
      assert.equal(await readFor(PEER), 1);
      assert.equal(await versionOf(GONE), goneAt, "a revoked kiosk was sent the face");
      assert.equal(await readFor(GONE), 0, "the face was opened for a revoked kiosk");
      assert.ok(!sent.includes(GONE), "a message went down to a revoked kiosk");
    } finally {
      down.mock.restore();
    }
  });

  it("keeps the time a person left a kiosk when they are removed again, so a punch in between is not theirs", async () => {
    const person = await db.employee.create({
      data: { code: TWICE, fullName: "Gỡ hai lần", active: true, legalEntityId: entityId },
    });
    await db.biometricConsent.create({ data: { employeeId: person.id, noticeVersion: "e2e", method: "PAPER" } });
    await app.get(EnrollmentService).assign(DEVICE_ID, person.id);
    const remove = () => request(http).delete(`/enrollments/${DEVICE_ID}/${person.id}`).set("Authorization", `Bearer ${admin}`);
    const first = await remove();
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const leftAt = new Date(first.body.revokedAt as string).getTime();
    await sleep(REMOVE_GAP_MS);
    const before = await db.device.findUniqueOrThrow({ where: { id: DEVICE_ID } });
    const second = await remove();
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(second.body.state, "REVOKED");
    assert.equal(second.body.revokedAt, first.body.revokedAt, "removing again moved the time the person left");
    const now = await db.device.findUniqueOrThrow({ where: { id: DEVICE_ID } });
    assert.equal(now.rosterVersion, before.rosterVersion + 1, "the kiosk was not told to drop the person again");

    const outcome = await app.get(AttendanceService).record(
      {
        deviceId: DEVICE_ID,
        localId: String(Date.now()),
        employeeId: person.id,
        ts: leftAt + BETWEEN_MS,
        direction: "IN",
        matchScore: 0.9,
        livenessScore: 0.9,
        modelVersion: 1,
      },
      new Date(),
    );
    assert.equal(outcome, "not-on-device", "a punch taken after the person left the kiosk was counted");
  });

  it("writes putting a person on a kiosk and taking them off under the person, with the kiosk and the state", async () => {
    const person = await db.employee.create({
      data: { code: AUDITED, fullName: "Ghi nhật ký", active: true, legalEntityId: entityId },
    });
    await db.biometricConsent.create({ data: { employeeId: person.id, noticeVersion: "e2e", method: "PAPER" } });
    const actor = await db.user.findUniqueOrThrow({ where: { email: "admin@kiosk.local" } });
    const routed = { subjectType: "route", subjectId: { startsWith: "/enrollments" } };
    const routedBefore = await db.auditLog.count({ where: routed });

    const put = await request(http)
      .post("/enrollments")
      .set("Authorization", `Bearer ${admin}`)
      .send({ deviceId: DEVICE_ID, employeeId: person.id });
    assert.equal(put.status, 201, JSON.stringify(put.body));
    const taken = await request(http).delete(`/enrollments/${DEVICE_ID}/${person.id}`).set("Authorization", `Bearer ${admin}`);
    assert.equal(taken.status, 200, JSON.stringify(taken.body));

    const lines = await db.auditLog.findMany({
      where: { subjectType: "employee", subjectId: String(person.id), action: { in: ["enrollment.assign", "enrollment.remove"] } },
      orderBy: { id: "asc" },
    });
    assert.deepEqual(
      lines.map((one) => [one.action, one.actorId, one.meta]),
      [
        ["enrollment.assign", actor.id, { deviceId: DEVICE_ID, state: "ASSIGNED" }],
        ["enrollment.remove", actor.id, { deviceId: DEVICE_ID, state: "REVOKED" }],
      ],
    );
    assert.equal(await db.auditLog.count({ where: routed }), routedBefore, "the route wrote a line of its own beside the service's");
  });
});
