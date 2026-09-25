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
import { MqttService } from "../src/modules/mqtt/mqtt.service.js";
import type { EnrollPayload } from "../src/common/generated/enroll_payload.js";

const DOOR_A = "e2e-door-a";
const DOOR_B = "e2e-door-b";
const DOOR_C = "e2e-door-c";
const DOOR_OLD = "e2e-door-old-model";
const DOOR_NEW = "e2e-door-new-model";
const DOORS = [DOOR_A, DOOR_B];
const CODE = "NV9200";
const CROWD = ["NV9201", "NV9202", "NV9203", "NV9204"];
const EMBEDDING_BYTES = 512;
const PUBLISH_MS = 25;
const AHEAD_BY = 50;

type Told = { to: string; op: string; employeeId: number; rosterVersion: number };

function capture(fill: number): string {
  return Buffer.alloc(EMBEDDING_BYTES, fill).toString("base64");
}

// Every sample of one capture session carries the session's start (KEHOACH 7.5).
function report(deviceId: string, employeeId: number, fill: number, session: number, templateIdx = 0, model = "r1"): EnrollPayload {
  return {
    op: "UPSERT",
    employeeId,
    templateIdx,
    updatedAt: session,
    embedding: capture(fill),
    scale: 0.0078125,
    quality: 255,
    embeddingVersion: model,
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
    await db.employee.deleteMany({ where: { code: { in: [CODE, ...CROWD] } } });
    await db.device.deleteMany({ where: { id: { in: [...DOORS, DOOR_C, DOOR_OLD, DOOR_NEW] } } });
  }

  // Every roster message the run sends, in the order it left; each takes PUBLISH_MS on the wire.
  async function recorded(run: () => Promise<unknown>, onSend?: () => void): Promise<Told[]> {
    const sent: Told[] = [];
    const spy = mock.method(app.get(MqttService), "publishDown", async (_name: string, to: string, payload: EnrollPayload) => {
      onSend?.();
      await sleep(PUBLISH_MS);
      sent.push({ to, op: payload.op, employeeId: payload.employeeId, rosterVersion: payload.rosterVersion ?? -1 });
    });
    try {
      await run();
    } finally {
      spy.mock.restore();
    }
    return sent;
  }

  function consecutive(numbers: number[]): boolean {
    return numbers.every((one, at) => one === numbers[0] + at);
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
      .send({ employeeId, method: "PAPER" });
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

  it("turns away a sample of the held session from a door that did not open it", async () => {
    const wasAt = await versionOf(DOOR_B);
    await enrollment.takeReport(DOOR_B, report(DOOR_B, employeeId, 0x99, FIRST, 2));
    assert.deepEqual((await samples()).map((one) => one.idx), [0, 1], "another door wrote into a session it never opened");
    assert.ok((await versionOf(DOOR_B)) > wasAt, "the door that tried was not brought back to the held samples");
  });

  it("turns away a late sample even from the door that opened the session", async () => {
    await db.deviceEnrollment.update({
      where: { deviceId_employeeId: { deviceId: DOOR_A, employeeId } },
      data: { sessionOpenedAt: new Date(Date.now() - 11 * 60_000) },
    });
    await enrollment.takeReport(DOOR_A, report(DOOR_A, employeeId, 0x98, FIRST, 2));
    assert.deepEqual((await samples()).map((one) => one.idx), [0, 1], "a session stayed open past its window");
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

  // Door A still holds the person; the remove case above leaves door B empty.
  it("sends the whole roster again, on numbers of its own, when a door reports an older version", async () => {
    const held = await versionOf(DOOR_A);
    const sent = await recorded(() => enrollment.converge(DOOR_A, held - 1));
    assert.equal(sent[0]?.op, "REPLACE_ALL");
    assert.equal(sent[0].rosterVersion, held + 1, "the run reused numbers already sent");
    assert.ok(consecutive(sent.map((one) => one.rosterVersion)));
    assert.equal(await versionOf(DOOR_A), sent[sent.length - 1].rosterVersion);
  });

  it("repairs a door whose counter stands behind its own roster", async () => {
    await db.device.update({ where: { id: DOOR_A }, data: { rosterVersion: 0 } });
    // The only repair path has to work from the state that needs repairing.
    const reached = await enrollment.resync(DOOR_A);
    assert.ok(reached >= 1, "a counter behind its roster sent a negative version and was refused");
    assert.equal(await versionOf(DOOR_A), reached);
  });

  it("gives one kiosk consecutive numbers while assignments land in the middle of a resync", async () => {
    await db.device.create({ data: { id: DOOR_C, name: DOOR_C, status: "APPROVED" } });
    const crowd: number[] = [];
    for (const code of CROWD) {
      const one = await db.employee.create({ data: { code, fullName: `Người ${code}`, active: true } });
      await db.biometricConsent.create({ data: { employeeId: one.id, noticeVersion: "e2e", method: "PAPER" } });
      crowd.push(one.id);
    }
    const [first, second, ...late] = crowd;
    await enrollment.assign(DOOR_C, first);
    await enrollment.assign(DOOR_C, second);
    let started = (): void => undefined;
    const running = new Promise<void>((done) => {
      started = done;
    });
    const sent = await recorded(async () => {
      const run = enrollment.resync(DOOR_C);
      await running;
      await Promise.all([run, ...late.map((id) => enrollment.assign(DOOR_C, id))]);
    }, () => started());
    const numbers = sent.filter((one) => one.to === DOOR_C).map((one) => one.rosterVersion);
    assert.ok(consecutive(numbers), `one kiosk heard ${numbers.join(", ")}`);
    assert.equal(numbers[numbers.length - 1], await versionOf(DOOR_C));
    const lateAt = sent.findIndex((one) => late.includes(one.employeeId));
    const runEnd = sent.findLastIndex((one) => one.op === "REPLACE_ALL" || one.employeeId === first || one.employeeId === second);
    assert.ok(lateAt > runEnd, "an assignment went out in the middle of the run");
  });

  it("pulls a kiosk that stands ahead of the server back into step", async () => {
    const held = await versionOf(DOOR_C);
    const sent = await recorded(() => enrollment.converge(DOOR_C, held + AHEAD_BY));
    assert.equal(sent[0]?.op, "REPLACE_ALL", "a kiosk ahead of the server was left there");
    assert.ok(sent[0].rosterVersion > held + AHEAD_BY, "the kiosk would drop every counted message after the run");
    assert.ok(consecutive(sent.map((one) => one.rosterVersion)));
    assert.equal(await versionOf(DOOR_C), sent[sent.length - 1].rosterVersion);
  });

  it("starts one resync per kiosk, leaves it to climb, and sends it again once it stalls", async () => {
    let heardDuring = new Date(0);
    const run = await recorded(
      () => enrollment.resync(DOOR_C),
      () => {
        heardDuring = new Date();
        void enrollment.converge(DOOR_C, 0);
      },
    );
    assert.equal(run.filter((one) => one.op === "REPLACE_ALL").length, 1, "a heartbeat during the run started a second one");
    assert.ok(run.length > 2, "the run is too short to stall inside");
    const from = run[0].rosterVersion;
    assert.deepEqual(await recorded(() => enrollment.converge(DOOR_C, 0, heardDuring)), [], "a beat heard mid-run set off a resync");
    assert.deepEqual(await recorded(() => enrollment.converge(DOOR_C, from + 1)), [], "a kiosk still applying the run was sent it again");
    const stalled = await recorded(() => enrollment.converge(DOOR_C, from + 1));
    assert.equal(stalled[0]?.op, "REPLACE_ALL", "a kiosk stuck inside the run was never sent it again");
  });

  it("asks a kiosk on another recognition model for the face again instead of sending one it would refuse", async () => {
    await db.device.update({ where: { id: DOOR_A }, data: { embeddingVersion: "r1" } });
    const same = await recorded(() => enrollment.resync(DOOR_A));
    assert.deepEqual(same.filter((one) => one.employeeId === employeeId).map((one) => one.op), ["UPSERT"]);

    await db.device.update({ where: { id: DOOR_A }, data: { embeddingVersion: "r2" } });
    const other = await recorded(() => enrollment.resync(DOOR_A));
    assert.deepEqual(
      other.filter((one) => one.employeeId === employeeId).map((one) => one.op),
      ["ASSIGN"],
      "a template of another model was sent, or nobody asked for the face",
    );
    assert.equal(await stateOf(DOOR_A), "ASSIGNED", "the dashboard still shows a face the kiosk has dropped");
  });

  it("sends a new face to the doors on its model only, and stops showing the others a face it cannot send", async () => {
    await db.device.createMany({
      data: [
        { id: DOOR_OLD, name: DOOR_OLD, status: "APPROVED", embeddingVersion: "r1" },
        { id: DOOR_NEW, name: DOOR_NEW, status: "APPROVED", embeddingVersion: "r2" },
      ],
    });
    await db.deviceEnrollment.createMany({
      data: [
        { deviceId: DOOR_OLD, employeeId, state: "ENROLLED" },
        { deviceId: DOOR_NEW, employeeId, state: "ASSIGNED" },
      ],
    });
    const oldAt = await versionOf(DOOR_OLD);
    const sent = await recorded(() => enrollment.takeReport(DOOR_A, report(DOOR_A, employeeId, 0x88, RETAKEN + 120_000, 0, "r2")));
    assert.deepEqual(sent.filter((one) => one.to === DOOR_OLD), [], "a door on the old model was sent a template it must refuse");
    assert.equal(await versionOf(DOOR_OLD), oldAt);
    assert.equal(await stateOf(DOOR_OLD), "ASSIGNED", "the dashboard still shows a face the server cannot give that door");
    assert.deepEqual(sent.filter((one) => one.to === DOOR_NEW).map((one) => one.op), ["DELETE_EMPLOYEE", "UPSERT"]);
    assert.equal(await stateOf(DOOR_NEW), "ENROLLED");
  });
});
