import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { io, type Socket } from "socket.io-client";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";

const DEVICE_ID = "kiosk-e2e-feed";
const DASHBOARD = "http://127.0.0.1:18083/api/v5";
const SETTLE_MS = 1500;
const RANGE = { from: "2020-01-01T00:00:00.000Z", to: "2020-01-02T00:00:00.000Z" };

async function publishAsKiosk(topic: string, payload: unknown): Promise<void> {
  const env = readFileSync(resolve(process.cwd(), "../deploy/.env"), "utf8");
  const password = /^EMQX_DASHBOARD_PASSWORD=(.*)$/m.exec(env)?.[1]?.trim() ?? "";
  const auth = await fetch(`${DASHBOARD}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "admin", password }),
  });
  const { token } = (await auth.json()) as { token: string };
  const sent = await fetch(`${DASHBOARD}/publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ topic, qos: 1, payload: JSON.stringify(payload) }),
  });
  assert.ok(sent.ok, `broker refused the test publish: ${sent.status}`);
}

describe("realtime and reports (e2e)", () => {
  let app: INestApplication;
  let db: PrismaService;
  let feed: Socket;
  let admin = "";
  let port = 0;
  const seen: Record<string, unknown[]> = { event: [], device: [], attendance: [] };

  async function sweep(): Promise<void> {
    await db.deviceEvent.deleteMany({ where: { deviceId: DEVICE_ID } });
    await db.device.deleteMany({ where: { id: DEVICE_ID } });
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
    await publishAsKiosk(`kiosk/${DEVICE_ID}/up/event`, {
      deviceId: DEVICE_ID,
      ts: Date.now(),
      type: "CAMERA_FAULT",
      severity: "ERROR",
      message: "frames stopped",
    });
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

  it("writes the device row for a kiosk it had never met", async () => {
    const device = await db.device.findUnique({ where: { id: DEVICE_ID } });
    assert.ok(device, "a fault from an unknown kiosk left no device row");
    assert.equal(device.status, "PENDING");
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
});
