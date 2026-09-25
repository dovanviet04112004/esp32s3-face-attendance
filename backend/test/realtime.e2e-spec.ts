import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import { io, type Socket } from "socket.io-client";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { GUARD } from "../src/common/cache/cache-keys.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { RedisService } from "../src/database/redis.service.js";
import { AuthService } from "../src/modules/auth/auth.service.js";
import { hashPassword } from "../src/modules/auth/password.js";
import { publishAsKiosk } from "./fixtures.js";

const DEVICE_ID = "kiosk-e2e-feed";
const STRANGER_ID = "kiosk-e2e-stranger";
const ASKING_ID = "kiosk-e2e-asking";
const SETTLE_MS = 1500;
const RANGE = { from: "2020-01-01T00:00:00.000Z", to: "2020-01-02T00:00:00.000Z" };
const LOCKED_MAIL = "e2e-rt-locked@kiosk.local";
const CUT_MAIL = "e2e-rt-cut@kiosk.local";
const PASSWORD = "kiosk-e2e-password";
const FOREIGN_ORIGIN = "https://elsewhere.example";

describe("realtime and reports (e2e)", () => {
  let app: INestApplication;
  let db: PrismaService;
  let feed: Socket;
  let admin = "";
  let port = 0;
  const seen: Record<string, unknown[]> = { event: [], device: [], attendance: [] };

  async function sweep(): Promise<void> {
    const ids = [DEVICE_ID, STRANGER_ID, ASKING_ID];
    await db.deviceEvent.deleteMany({ where: { deviceId: { in: ids } } });
    await db.device.deleteMany({ where: { id: { in: ids } } });
    await db.user.deleteMany({ where: { email: { in: [LOCKED_MAIL, CUT_MAIL] } } });
  }

  /** Whether a socket carrying this ticket is still on the feed once the handshake settles. */
  async function stays(token: string): Promise<{ socket: Socket; open: boolean }> {
    const socket = io(`http://127.0.0.1:${port}/feed`, {
      transports: ["websocket"],
      reconnection: false,
      auth: { token },
    });
    await new Promise<void>((done) => {
      socket.on("connect", () => done());
      socket.on("connect_error", () => done());
    });
    await new Promise((done) => setTimeout(done, SETTLE_MS));
    return { socket, open: socket.connected };
  }

  async function account(email: string): Promise<{ id: string; token: string }> {
    const made = await db.user.create({
      data: { email, passwordHash: await hashPassword(PASSWORD), role: "HR" },
    });
    const signed = await app.get(AuthService).signIn(email, PASSWORD, {});
    return { id: made.id, token: signed.accessToken };
  }

  function fault(deviceId: string): Promise<void> {
    return publishAsKiosk(`kiosk/${deviceId}/up/event`, {
      deviceId,
      ts: Date.now(),
      type: "CAMERA_FAULT",
      severity: "ERROR",
      message: "frames stopped",
    });
  }

  before(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    await app.listen(0);
    const address = app.getHttpServer().address() as { port: number };
    port = address.port;
    db = app.get(PrismaService);
    await sweep();
    await db.device.create({ data: { id: DEVICE_ID, status: "APPROVED" } });

    const login = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email: "admin@kiosk.local", password: validateEnv().SEED_ADMIN_PASSWORD });
    admin = login.body.accessToken;

    feed = io(`http://127.0.0.1:${port}/feed`, {
      transports: ["websocket"],
      auth: { token: admin },
    });
    for (const name of Object.keys(seen)) {
      feed.on(name, (body: unknown) => seen[name].push(body));
    }
    await new Promise<void>((done) => {
      feed.on("connect", () => done());
    });
  });

  after(async () => {
    feed.close();
    await sweep();
    await app.close();
  });

  it("keeps a kiosk fault and shows it on the feed at the same time", async () => {
    await fault(DEVICE_ID);
    await new Promise((done) => setTimeout(done, SETTLE_MS));

    const held = await db.deviceEvent.findFirst({
      where: { deviceId: DEVICE_ID, type: "CAMERA_FAULT" },
    });
    assert.ok(held, "the fault was not kept");
    assert.equal(held.severity, "ERROR");

    const shown = seen.event.find(
      (body) => (body as { type?: string }).type === "CAMERA_FAULT",
    );
    assert.ok(shown, "the fault never reached an open dashboard");
  });

  it("drops what a kiosk nobody approved says, and writes no row for it", async () => {
    await fault(STRANGER_ID);
    await new Promise((done) => setTimeout(done, SETTLE_MS));
    assert.equal(await db.device.findUnique({ where: { id: STRANGER_ID } }), null);
    assert.equal(await db.deviceEvent.count({ where: { deviceId: STRANGER_ID } }), 0);
    const shown = seen.event.some((body) => (body as { deviceId?: string }).deviceId === STRANGER_ID);
    assert.equal(shown, false, "a stranger's fault reached the dashboard");
  });

  it("stops hearing a kiosk the moment it is revoked", async () => {
    await db.device.update({ where: { id: DEVICE_ID }, data: { status: "REVOKED" } });
    const kept = await db.deviceEvent.count({ where: { deviceId: DEVICE_ID } });
    await fault(DEVICE_ID);
    await new Promise((done) => setTimeout(done, SETTLE_MS));
    assert.equal(await db.deviceEvent.count({ where: { deviceId: DEVICE_ID } }), kept);
  });

  it("tells an open dashboard when a kiosk asks to be let in", async () => {
    const asked = await request(app.getHttpServer())
      .post("/devices/register")
      .send({ deviceId: ASKING_ID, bootstrapToken: validateEnv().DEVICE_BOOTSTRAP_TOKEN, claimCode: "271828" });
    assert.equal(asked.status, 202);
    await new Promise((done) => setTimeout(done, SETTLE_MS));
    const told = seen.device.some((body) => {
      const change = body as { deviceId?: string; status?: string };
      return change.deviceId === ASKING_ID && change.status === "PENDING";
    });
    assert.ok(told, "the devices page would need a reload to see the new kiosk");
  });

  it("answers a report twice and the second one costs no query", async () => {
    const path = `/reports/attendance?from=${RANGE.from}&to=${RANGE.to}`;
    const cold = await request(app.getHttpServer())
      .get(path)
      .set("Authorization", `Bearer ${admin}`);
    assert.equal(cold.status, 200);
    const warm = await request(app.getHttpServer())
      .get(path)
      .set("Authorization", `Bearer ${admin}`);
    assert.equal(warm.status, 200);
    assert.deepEqual(warm.body, cold.body);
  });

  it("queues one run for a range however often it is asked for", async () => {
    const ask = () =>
      request(app.getHttpServer())
        .post("/reports/attendance/monthly")
        .set("Authorization", `Bearer ${admin}`)
        .send(RANGE);
    const first = await ask();
    const second = await ask();
    assert.equal(first.status, 201);
    assert.equal(first.body.jobId, second.body.jobId);
  });

  it("refuses a report range that is not a pair of instants", async () => {
    const res = await request(app.getHttpServer())
      .get("/reports/attendance?from=yesterday&to=today")
      .set("Authorization", `Bearer ${admin}`);
    assert.equal(res.status, 400);
  });

  it("closes a locked account's socket and refuses it a new one on the same ticket", async () => {
    const held = await account(LOCKED_MAIL);
    const first = await stays(held.token);
    assert.equal(first.open, true, "a live ticket was refused");

    await db.user.update({ where: { id: held.id }, data: { active: false } });
    await app.get(AuthService).closeAll(held.id);
    await new Promise((done) => setTimeout(done, SETTLE_MS));
    assert.equal(first.socket.connected, false, "the locked account kept its open socket");

    const again = await stays(held.token);
    assert.equal(again.open, false, "a locked account opened a socket on the ticket it held");
    first.socket.close();
    again.socket.close();
  });

  it("refuses a socket whose ticket predates its account's cutoff", async () => {
    const held = await account(CUT_MAIL);
    const { iat } = app.get(JwtService).decode(held.token) as { iat: number };
    const redis = app.get(RedisService).client;
    await redis.set(GUARD.accessCutoff(held.id), String(iat + 1), "EX", 60);
    try {
      const late = await stays(held.token);
      assert.equal(late.open, false, "a demoted account's old ticket opened the feed");
      late.socket.close();
    } finally {
      await redis.del(GUARD.accessCutoff(held.id));
    }
  });

  it("answers the feed's handshake only to the origins REST answers", async () => {
    const [allowed] = validateEnv().CORS_ORIGIN.split(",");
    const handshake = "/socket.io/?EIO=4&transport=polling";
    const ours = await request(app.getHttpServer()).get(handshake).set("Origin", allowed);
    assert.equal(ours.headers["access-control-allow-origin"], allowed);
    const theirs = await request(app.getHttpServer()).get(handshake).set("Origin", FOREIGN_ORIGIN);
    assert.notEqual(
      theirs.headers["access-control-allow-origin"],
      FOREIGN_ORIGIN,
      "any site may open the feed from a signed-in browser",
    );
  });
});
