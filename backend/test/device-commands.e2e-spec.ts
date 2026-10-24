import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import type { DeviceCommand } from "../src/common/generated/device_cmd.js";
import type { Heartbeat } from "../src/common/generated/heartbeat.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { KIOSK_EVENT } from "../src/modules/mqtt/mqtt.events.js";
import { MqttService } from "../src/modules/mqtt/mqtt.service.js";
import { signIn } from "./fixtures.js";

const DOOR = "e2e-cmd-door";
const QUIET = "e2e-cmd-offline";
const GONE = "e2e-cmd-revoked";
const NEIGHBOUR = "e2e-cmd-neighbour";
const DOORS = [DOOR, QUIET, GONE, NEIGHBOUR];

describe("commands to one kiosk (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let admin = "";
  const sent: { name: string; deviceId: string; payload: DeviceCommand }[] = [];

  function send(deviceId: string, body: object): request.Test {
    return request(http).post(`/devices/${deviceId}/commands`).set("Authorization", `Bearer ${admin}`).send(body);
  }

  async function answer(type: "COMMAND_DONE" | "COMMAND_REJECTED", cmdId: string, message: string, deviceId = DOOR): Promise<void> {
    const at = new Date();
    // Every listener hears it as the broker's listener hands it over (KEHOACH 7.5).
    await app.get(EventEmitter2).emitAsync(KIOSK_EVENT.event, {
      topic: "event",
      deviceId,
      receivedAt: at,
      payload: { deviceId, ts: at.getTime(), type, severity: "INFO", cmdId, message },
    });
  }

  async function beat(extra: Partial<Heartbeat>, retained: boolean, receivedAt = new Date()): Promise<void> {
    await app.get(EventEmitter2).emitAsync(KIOSK_EVENT.heartbeat, {
      topic: "heartbeat",
      deviceId: DOOR,
      receivedAt,
      retained,
      payload: { deviceId: DOOR, ts: receivedAt.getTime(), uptimeSeconds: 600, fwVersion: "0.0.0-e2e", modelVersion: "e2e", ...extra },
    });
  }

  async function shown(): Promise<Record<string, unknown>> {
    const res = await request(http).get(`/devices/${DOOR}`).set("Authorization", `Bearer ${admin}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body as Record<string, unknown>;
  }

  async function stateOf(cmdId: string): Promise<{ state: string; resultNote: string | null }> {
    const listed = await request(http).get(`/devices/${DOOR}/commands`).set("Authorization", `Bearer ${admin}`);
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    const row = (listed.body.rows as { cmdId: string; state: string; resultNote: string | null }[]).find((one) => one.cmdId === cmdId);
    assert.ok(row, `${cmdId} is not in the kiosk's commands`);
    return { state: row.state, resultNote: row.resultNote };
  }

  before(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    http = app.getHttpServer();
    db = app.get(PrismaService);
    app.get(MqttService).publishDown = async (name: string, deviceId: string, payload: unknown) => {
      sent.push({ name, deviceId, payload: payload as DeviceCommand });
    };
    await db.device.deleteMany({ where: { id: { in: DOORS } } });
    await db.device.createMany({
      data: [
        { id: DOOR, status: "APPROVED", online: true },
        { id: QUIET, status: "APPROVED", online: false },
        { id: GONE, status: "REVOKED", online: true },
        { id: NEIGHBOUR, status: "APPROVED", online: true },
      ],
    });
    admin = await signIn(http, "admin@kiosk.local", validateEnv().SEED_ADMIN_PASSWORD ?? "");
  });

  after(async () => {
    await db.device.deleteMany({ where: { id: { in: DOORS } } });
    await app.close();
  });

  it("puts the command on down/cmd with the id, deadline and sender the server gave it", async () => {
    sent.length = 0;
    const res = await send(DOOR, { action: "OPEN_DOOR", openMs: 3000 });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.state, "SENT");
    const [out] = sent;
    assert.equal(out.name, "cmd");
    assert.equal(out.deviceId, DOOR);
    assert.equal(out.payload.cmdId, res.body.cmdId);
    assert.equal(out.payload.action, "OPEN_DOOR");
    assert.equal(out.payload.openMs, 3000);
    const ttl = validateEnv().DEVICE_COMMAND_TTL_SECONDS * 1000;
    assert.equal((out.payload.expiresAt ?? 0) - out.payload.ts, ttl);
    assert.ok(out.payload.issuedBy, "the kiosk is not told who sent it");
    const logged = await db.auditLog.count({ where: { action: "device.command", subjectId: DOOR } });
    assert.ok(logged >= 1, "a command left no audit row");
  });

  it("closes the command on the kiosk's answer, once", async () => {
    const res = await send(DOOR, { action: "SYNC_TIME" });
    const cmdId = res.body.cmdId as string;
    await answer("COMMAND_DONE", cmdId, "sntp asked again");
    assert.deepEqual(await stateOf(cmdId), { state: "DONE", resultNote: "sntp asked again" });
    await answer("COMMAND_REJECTED", cmdId, "a late copy");
    assert.deepEqual(await stateOf(cmdId), { state: "DONE", resultNote: "sntp asked again" }, "a redelivered answer rewrote the row");
  });

  it("takes no answer from another kiosk", async () => {
    const res = await send(DOOR, { action: "DIAGNOSTICS" });
    const cmdId = res.body.cmdId as string;
    await answer("COMMAND_DONE", cmdId, "not mine", NEIGHBOUR);
    assert.equal((await stateOf(cmdId)).state, "SENT");
  });

  it("reads a command past its deadline with no answer as expired", async () => {
    const res = await send(DOOR, { action: "ROTATE_TOKEN" });
    const cmdId = res.body.cmdId as string;
    await db.deviceCommand.update({ where: { cmdId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    assert.equal((await stateOf(cmdId)).state, "EXPIRED");
  });

  it("sends operating settings and refuses a model threshold or a value out of range", async () => {
    sent.length = 0;
    const ok = await send(DOOR, { action: "SET_CONFIG", config: { dedupWindowMinutes: 10, faceMinPx: 96, lang: "en" } });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.deepEqual(sent[0].payload.config, { dedupWindowMinutes: 10, faceMinPx: 96, lang: "en" });
    for (const config of [{ matchThreshold: 0.3 }, { dedupWindowMinutes: 0 }, { brightness: 300 }, {}]) {
      const refused = await send(DOOR, { action: "SET_CONFIG", config });
      assert.equal(refused.status, 400, `${JSON.stringify(config)} went through`);
      assert.equal(refused.body.message, "COMMAND_INVALID");
    }
    const noSlot = await send(DOOR, { action: "SET_ACTIVE_SLOT" });
    assert.equal(noSlot.body.message, "COMMAND_INVALID");
    assert.equal(sent.length, 1, "a refused command reached the kiosk");
  });

  it("pages every command of a kiosk newest first, with the total, so none drops off the end", async () => {
    const base = Date.parse("2026-10-01T08:00:00.000Z");
    const [tieLow, tieHigh] = [randomUUID(), randomUUID()].sort();
    const made = [
      { cmdId: randomUUID(), at: base },
      { cmdId: randomUUID(), at: base + 60_000 },
      { cmdId: tieLow, at: base + 120_000 },
      { cmdId: tieHigh, at: base + 120_000 },
      { cmdId: randomUUID(), at: base + 180_000 },
    ];
    await db.deviceCommand.createMany({
      data: made.map((one) => ({ cmdId: one.cmdId, deviceId: NEIGHBOUR, action: "SYNC_TIME", state: "DONE" as const, createdAt: new Date(one.at) })),
    });
    const seen: string[] = [];
    let cursor = "";
    for (let page = 0; page < 4; page += 1) {
      const res = await request(http)
        .get(`/devices/${NEIGHBOUR}/commands`)
        .query({ take: 2, ...(cursor ? { cursor } : {}) })
        .set("Authorization", `Bearer ${admin}`);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.total, made.length);
      seen.push(...(res.body.rows as { cmdId: string }[]).map((one) => one.cmdId));
      cursor = res.body.next ?? "";
      if (!cursor) {
        break;
      }
    }
    assert.deepEqual(seen, [made[4].cmdId, tieHigh, tieLow, made[1].cmdId, made[0].cmdId]);
  });

  it("refuses a kiosk that is offline or out of the fleet", async () => {
    const quiet = await send(QUIET, { action: "OPEN_DOOR" });
    assert.equal(quiet.status, 409);
    assert.equal(quiet.body.message, "DEVICE_OFFLINE");
    const gone = await send(GONE, { action: "OPEN_DOOR" });
    assert.equal(gone.status, 409);
    assert.equal(gone.body.message, "DEVICE_NOT_APPROVED");
  });

  it("keeps the command and says so when the broker does not take it", async () => {
    const mqtt = app.get(MqttService);
    const held = mqtt.publishDown;
    mqtt.publishDown = async () => {
      throw new Error("no broker connection");
    };
    try {
      const res = await send(DOOR, { action: "OPEN_DOOR" });
      assert.equal(res.status, 409);
      assert.equal(res.body.message, "COMMAND_NOT_SENT");
    } finally {
      mqtt.publishDown = held;
    }
    const row = await db.deviceCommand.findFirstOrThrow({ where: { deviceId: DOOR }, orderBy: { createdAt: "desc" } });
    assert.equal(row.state, "REJECTED");
  });

  it("shows the health of the last live heartbeat, the answer a diagnostics press waits for", async () => {
    const heard = new Date();
    await beat(
      { rssiDbm: -61, heapFreeBytes: 41_216, heapMinFreeBytes: 24_576, psramFreeBytes: 3_407_872, pendingUplinkCount: 2, activeSlot: 1, bootCount: 129 },
      false,
      heard,
    );
    await beat({ rssiDbm: -90, activeSlot: 0, bootCount: 3 }, true);
    const live = await shown();
    assert.deepEqual(
      [live.rssiDbm, live.heapFreeBytes, live.heapMinFreeBytes, live.psramFreeBytes, live.pendingUplinkCount, live.activeSlot, live.bootCount],
      [-61, 41_216, 24_576, 3_407_872, 2, 1, 129],
      "the broker's retained copy overwrote what the kiosk said live",
    );
    assert.equal(live.healthAt, heard.toISOString());
    assert.equal(live.bootedAt, new Date(heard.getTime() - 600_000).toISOString());

    await beat({ activeSlot: 0 }, false);
    const next = await shown();
    assert.equal(next.activeSlot, 0);
    assert.equal(next.rssiDbm, null, "a number the newest beat lacked stayed from an older one");
    assert.equal(next.pendingUplinkCount, null);
  });
});
