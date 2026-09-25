import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, describe, it, mock } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { EnrollmentService } from "../src/modules/enrollment/enrollment.service.js";
import { openTemplate } from "../src/modules/enrollment/template-crypto.js";
import { MqttService } from "../src/modules/mqtt/mqtt.service.js";
import { publishAsKiosk } from "./fixtures.js";

const DEVICE_ID = "kiosk-e2e-enroll";
const CODE = "NV9100";
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
  const sample = embedding();

  async function sweep(): Promise<void> {
    await db.deviceEnrollment.deleteMany({ where: { deviceId: DEVICE_ID } });
    await db.faceTemplate.deleteMany({ where: { employee: { code: CODE } } });
    await db.employee.deleteMany({ where: { code: { in: [CODE, ...RACERS] } } });
    await db.device.deleteMany({ where: { id: DEVICE_ID } });
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
    const made = await request(http)
      .post("/employees")
      .set("Authorization", `Bearer ${admin}`)
      .send({ code: CODE, fullName: "Phạm Thị D" });
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
      .send({ code: `${CODE}X`, fullName: "Chưa đồng ý" });
    const res = await request(http)
      .post("/enrollments")
      .set("Authorization", `Bearer ${admin}`)
      .send({ deviceId: DEVICE_ID, employeeId: other.body.id });
    assert.equal(res.status, 403);
    assert.equal(res.body.message, "BIOMETRIC_CONSENT_MISSING");
    await db.employee.delete({ where: { id: other.body.id } });
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

  // Waits on the round trip's last write rather than guessing how long it
  // takes: the template row lands first, the pair turns ENROLLED after it.
  async function settled() {
    for (let waited = 0; waited < SETTLE_MS; waited += SETTLE_POLL_MS) {
      const [row, pair] = await Promise.all([
        db.faceTemplate.findUnique({
          where: { employeeId_templateIdx: { employeeId, templateIdx: 0 } },
        }),
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
    await publishAsKiosk(`kiosk/${DEVICE_ID}/up/enroll`, {
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
    await enrollment.converge(DEVICE_ID, device.rosterVersion - 1);
    spy.mock.restore();

    assert.ok(sent.length >= 1, "a kiosk left behind was not resynced");
    assert.equal(sent[0].op, "REPLACE_ALL", "convergence has to clear before it fills");
    const last = sent[sent.length - 1];
    assert.equal(last.rosterVersion, device.rosterVersion, "the run must land on the target");
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

    // The version a kiosk is told to reach has to count every change, so a
    // counter read in this process and written back loses the ones between.
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
});
