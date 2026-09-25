import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, describe, it, mock } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { MqttClient } from "mqtt";

import type { AttendanceRecord } from "../src/common/generated/attendance_record.js";
import type { Heartbeat } from "../src/common/generated/heartbeat.js";
import type { KioskMessage } from "../src/modules/mqtt/mqtt.events.js";
import { publishAsKiosk } from "./fixtures.js";

// Every running api hears every kiosk, so this suite runs alone, on a session of its own name.
process.env.MQTT_CLIENT_ID = `svc-e2e-session-${process.pid}`;
const { AppModule } = await import("../src/app.module.js");
const { configure } = await import("../src/bootstrap.js");
const { TOPICS } = await import("../src/common/generated/topics.js");
const { PrismaService } = await import("../src/database/prisma.service.js");
const { AttendanceListener } = await import("../src/modules/attendance/attendance.listener.js");
const { EnrollmentListener } = await import("../src/modules/enrollment/enrollment.listener.js");
const { MqttService } = await import("../src/modules/mqtt/mqtt.service.js");

const KIOSK = "e2e-session-kiosk";
const CODE = "NV9300";
const PUNCHES = `kiosk/${KIOSK}/up/attendance`;
const BEATS = `kiosk/${KIOSK}/up/heartbeat`;
const SETTLE_MS = 20_000;
const POLL_MS = 100;
const QUIET_MS = 1500;
const LONG_AGO = new Date("2026-01-01T00:00:00Z");
const SERVER_ROSTER = 5;

describe("broker session (e2e)", () => {
  let app: INestApplication;
  let db: InstanceType<typeof PrismaService>;
  let mqtt: InstanceType<typeof MqttService>;
  let client: MqttClient;
  let employeeId = 0;

  function punch(localId: string): AttendanceRecord {
    return {
      deviceId: KIOSK,
      localId,
      employeeId,
      ts: Date.now(),
      direction: "IN",
      matchScore: 0.9,
      livenessScore: 0.9,
      modelVersion: 1,
    };
  }

  function beat(): Heartbeat {
    return {
      deviceId: KIOSK,
      ts: Date.now(),
      uptimeSeconds: 60,
      fwVersion: "0.9.9",
      modelVersion: "img-e2e00009",
      embeddingVersion: "recog-e2e0000000000009",
      rosterVersion: 0,
    };
  }

  async function stored(localId: string): Promise<number> {
    return db.attendanceRecord.count({ where: { deviceId: KIOSK, localId } });
  }

  async function until(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
    for (let waited = 0; waited < SETTLE_MS; waited += POLL_MS) {
      if (await check()) {
        return;
      }
      await sleep(POLL_MS);
    }
    throw new Error(`${what} did not happen in ${SETTLE_MS} ms`);
  }

  async function sweep(): Promise<void> {
    await db.attendanceRecord.deleteMany({ where: { deviceId: KIOSK } });
    await db.device.deleteMany({ where: { id: KIOSK } });
    await db.employee.deleteMany({ where: { code: CODE } });
  }

  before(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    db = app.get(PrismaService);
    mqtt = app.get(MqttService);
    client = (mqtt as unknown as { client: MqttClient }).client;
    await sweep();
    await db.device.create({ data: { id: KIOSK, status: "APPROVED", rosterVersion: SERVER_ROSTER } });
    employeeId = (await db.employee.create({ data: { code: CODE, fullName: "Người chấm qua phiên bền", active: true } })).id;
  });

  after(async () => {
    await publishAsKiosk(BEATS, null, { qos: 0, retain: true });
    await sweep();
    await app.close();
  });

  it("hears a punch while it is connected", async () => {
    await until(() => client.connected, "the first connect");
    // The subscriptions go out after the connect; a punch ahead of them would find no session to wait in.
    await sleep(QUIET_MS);
    await publishAsKiosk(PUNCHES, punch("1000"));
    await until(async () => (await stored("1000")) === 1, "the punch sent while connected");
  });

  it("keeps what a kiosk sends while the api is away, and takes it once back", async () => {
    await client.endAsync();
    await publishAsKiosk(PUNCHES, punch("1001"));
    await sleep(QUIET_MS);
    assert.equal(await stored("1001"), 0, "a closed session still took a message");
    client.reconnect();
    await until(async () => (await stored("1001")) === 1, "the punch sent while the api was away");
  });

  it("runs a failed handler again before it tells the broker the message is done", async () => {
    const listener = app.get(AttendanceListener);
    const real = listener.onPunch.bind(listener);
    let calls = 0;
    const spy = mock.method(listener, "onPunch", async (message: KioskMessage<AttendanceRecord>) => {
      calls += 1;
      if (calls === 1) {
        throw new Error("the database blinked");
      }
      return real(message);
    });
    try {
      await publishAsKiosk(PUNCHES, punch("1002"));
      await until(async () => (await stored("1002")) === 1, "the punch whose handler failed once");
    } finally {
      spy.mock.restore();
    }
    assert.equal(calls, 2);
  });

  it("gets a message back from the broker when the link dies before its handler finished", async () => {
    const listener = app.get(AttendanceListener);
    const real = listener.onPunch.bind(listener);
    let calls = 0;
    const spy = mock.method(listener, "onPunch", async (message: KioskMessage<AttendanceRecord>) => {
      calls += 1;
      if (calls === 1) {
        client.stream.destroy();
        await until(() => !client.connected, "the cut");
        throw new Error("the link died mid-handler");
      }
      return real(message);
    });
    try {
      await publishAsKiosk(PUNCHES, punch("1003"));
      await until(async () => (await stored("1003")) === 1, "the punch cut off mid-handler");
    } finally {
      spy.mock.restore();
    }
    assert.equal(calls, 2, "the broker did not deliver the unacknowledged message again");
  });

  it("reads the broker's retained heartbeat as what the kiosk last ran, not as a sign it is up", async () => {
    await db.device.update({
      where: { id: KIOSK },
      data: { lastSeenAt: LONG_AGO, online: false, bootedAt: null, rosterVersion: SERVER_ROSTER },
    });
    const listener = app.get(EnrollmentListener);
    const real = listener.onHeartbeat.bind(listener);
    const heard: (boolean | undefined)[] = [];
    const spy = mock.method(listener, "onHeartbeat", async (message: KioskMessage<Heartbeat>) => {
      await real(message);
      heard.push(message.retained);
    });
    const told: string[] = [];
    const down = mock.method(mqtt, "publishDown", async (_name: string, to: string) => {
      told.push(to);
    });
    try {
      await client.unsubscribeAsync(TOPICS.heartbeat.wildcard);
      await publishAsKiosk(BEATS, beat(), { qos: 0, retain: true });
      await client.subscribeAsync(TOPICS.heartbeat.wildcard, { qos: 0, rh: 1 });
      await until(() => heard.length > 0, "the retained heartbeat");
      assert.deepEqual(heard, [true], "the broker's copy did not arrive marked retained");
      const row = await db.device.findUniqueOrThrow({ where: { id: KIOSK } });
      assert.equal(row.lastSeenAt?.getTime(), LONG_AGO.getTime(), "a replayed beat counted as the kiosk being seen");
      assert.equal(row.online, false, "a replayed beat showed a kiosk that is off as running");
      assert.equal(row.bootedAt, null, "a replayed beat moved the boot time an update offer is read against");
      assert.equal(row.fwVersion, "0.9.9", "the replayed beat's versions were not kept");
      assert.equal(row.embeddingVersion, "recog-e2e0000000000009");
      assert.equal(told.length, 0, "a replayed beat set off a resync");

      await publishAsKiosk(BEATS, beat(), { qos: 0 });
      await until(() => heard.length > 1, "the live heartbeat");
      const live = await db.device.findUniqueOrThrow({ where: { id: KIOSK } });
      assert.ok((live.lastSeenAt?.getTime() ?? 0) > LONG_AGO.getTime(), "a live beat did not mark the kiosk seen");
      assert.equal(live.online, true);
      assert.ok(told.includes(KIOSK), "a live beat behind the server's roster did not converge");
    } finally {
      spy.mock.restore();
      down.mock.restore();
    }
  });
});
