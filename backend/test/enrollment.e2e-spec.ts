import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, describe, it, mock } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { otaManifestSchema } from "../src/common/generated/ota_manifest.js";
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
const RELEASE_VERSION = "9.9.9";
const SETTLE_MS = 15000;
const SETTLE_POLL_MS = 50;

function embedding(): string {
  const raw = Buffer.alloc(EMBEDDING_BYTES);
  for (let i = 0; i < EMBEDDING_BYTES; i += 1) {
    raw[i] = (i * 7) % 256;
  }
  return raw.toString("base64");
}

describe("enrollment and releases (e2e)", () => {
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
    await db.release.deleteMany({ where: { version: RELEASE_VERSION } });
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
      .send({ employeeId, noticeVersion: "test-v1", method: "PAPER" });
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

  it("offers a registered release as a manifest the kiosk can read", async () => {
    // The row is written straight in: what is under test here is the manifest,
    // and registering one reads the image over the network.
    const made = await db.release.create({
      data: {
        releaseId: randomUUID(),
        target: "MODELS",
        version: RELEASE_VERSION,
        url: "https://example.com/models.bin",
        sha256: "a".repeat(64),
        sizeBytes: 1517600,
        minFwVersion: "0.9.0",
      },
    });

    const offered = await request(http)
      .post(`/releases/${made.releaseId}/offer/${DEVICE_ID}`)
      .set("Authorization", `Bearer ${admin}`);
    assert.equal(offered.status, 201);
    const checked = otaManifestSchema.safeParse(offered.body);
    assert.ok(checked.success, `manifest is outside its contract: ${checked.error?.message}`);
    assert.equal(offered.body.target, "MODELS");
  });

  it("refuses a release it cannot read, rather than recording a guess", async () => {
    const res = await request(http)
      .post("/releases")
      .set("Authorization", `Bearer ${admin}`)
      .send({
        target: "FIRMWARE",
        version: "9.9.8",
        // Nothing listens on port 1, so this fails to connect without a network.
        url: "https://127.0.0.1:1/kiosk.bin",
      });
    assert.equal(res.status, 400);
    assert.equal(res.body.message, "RELEASE_UNREACHABLE");
  });

  it("refuses a release url that is not https", async () => {
    const res = await request(http)
      .post("/releases")
      .set("Authorization", `Bearer ${admin}`)
      .send({
        target: "FIRMWARE",
        version: "9.9.7",
        url: "http://example.com/kiosk.bin",
      });
    assert.equal(res.status, 400);
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
          .send({ employeeId: one.id, noticeVersion: "2026-01-v1", method: "PAPER" }),
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
});
