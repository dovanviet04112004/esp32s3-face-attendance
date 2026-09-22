import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import { io, type Socket } from "socket.io-client";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { AuthService } from "../src/modules/auth/auth.service.js";
import { hashPassword } from "../src/modules/auth/password.js";
import { FEED, RealtimeGateway } from "../src/modules/realtime/realtime.gateway.js";

const BOSS = "E2EFS01";
const UNDER = "E2EFS02";
const STRANGER = "E2EFS03";
const BOSS_MAIL = "e2efs-boss@kiosk.local";
const STRANGER_MAIL = "e2efs-stranger@kiosk.local";
const PASSWORD = "kiosk-e2e-password";
const SETTLE_MS = 400;
const EXPIRY_MS = 1500;

describe("who the feed talks to (e2e)", () => {
  let app: INestApplication;
  let db: PrismaService;
  let gateway: RealtimeGateway;
  let port = 0;
  let bossToken = "";
  let strangerToken = "";
  let underId = 0;

  async function sweep(): Promise<void> {
    await db.user.deleteMany({ where: { email: { in: [BOSS_MAIL, STRANGER_MAIL] } } });
    await db.employee.deleteMany({ where: { code: { in: [UNDER, BOSS, STRANGER] } } });
  }

  /** Open a socket and gather what it is told, so a test can assert silence. */
  async function watch(token?: string): Promise<{ heard: unknown[]; socket: Socket }> {
    const heard: unknown[] = [];
    const socket = io(`http://127.0.0.1:${port}/feed`, {
      transports: ["websocket"],
      reconnection: false,
      ...(token ? { auth: { token } } : {}),
    });
    for (const name of Object.values(FEED)) {
      socket.on(name, (body: unknown) => heard.push(body));
    }
    await new Promise<void>((done) => socket.on("connect", () => done()));
    await new Promise((done) => setTimeout(done, SETTLE_MS));
    return { heard, socket };
  }

  before(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    await app.listen(0);
    port = (app.getHttpServer().address() as { port: number }).port;
    db = app.get(PrismaService);
    gateway = app.get(RealtimeGateway);
    await sweep();

    const boss = await db.employee.create({
      data: { code: BOSS, fullName: "Quản lý feed", active: true },
    });
    const under = await db.employee.create({
      data: { code: UNDER, fullName: "Cấp dưới feed", active: true, managerId: boss.id },
    });
    underId = under.id;
    const stranger = await db.employee.create({
      data: { code: STRANGER, fullName: "Người ngoài feed", active: true },
    });
    const passwordHash = await hashPassword(PASSWORD);
    await db.user.create({
      data: { email: BOSS_MAIL, passwordHash, role: "MANAGER", employeeId: boss.id },
    });
    await db.user.create({
      data: { email: STRANGER_MAIL, passwordHash, role: "EMPLOYEE", employeeId: stranger.id },
    });
    // Through the service: the login door is counted by the minute and this
    // suite would spend the allowance on setup.
    const auth = app.get(AuthService);
    bossToken = (await auth.signIn(BOSS_MAIL, PASSWORD, {})).accessToken;
    strangerToken = (await auth.signIn(STRANGER_MAIL, PASSWORD, {})).accessToken;
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("turns away a socket carrying no ticket", async () => {
    const socket = io(`http://127.0.0.1:${port}/feed`, {
      transports: ["websocket"],
      reconnection: false,
    });
    await new Promise<void>((done) => {
      socket.on("connect", () => done());
      socket.on("connect_error", () => done());
    });
    await new Promise((done) => setTimeout(done, SETTLE_MS));
    assert.equal(socket.connected, false, "a socket with no ticket stayed on the feed");
    socket.close();
  });

  it("turns away a ticket it cannot read", async () => {
    const socket = io(`http://127.0.0.1:${port}/feed`, {
      transports: ["websocket"],
      reconnection: false,
      auth: { token: `${bossToken}tampered` },
    });
    await new Promise<void>((done) => {
      socket.on("connect", () => done());
      socket.on("connect_error", () => done());
    });
    await new Promise((done) => setTimeout(done, SETTLE_MS));
    assert.equal(socket.connected, false, "a forged ticket stayed on the feed");
    socket.close();
  });

  it("keeps kiosk news to the desk that runs the fleet", async () => {
    const boss = await watch(bossToken);
    const stranger = await watch(strangerToken);

    gateway.publish(FEED.device, { deviceId: "kiosk-e2e-scope", online: true });
    await new Promise((done) => setTimeout(done, SETTLE_MS));

    assert.deepEqual(boss.heard, [], "a manager was told about a kiosk");
    assert.deepEqual(stranger.heard, [], "an employee was told about a kiosk");
    boss.socket.close();
    stranger.socket.close();
  });

  it("drops a socket whose ticket has run out", async () => {
    const stale = app.get(JwtService).sign(
      { sub: "e2e-feed", role: "ADMIN", employeeId: null },
      { secret: validateEnv().JWT_ACCESS_SECRET, expiresIn: 1 },
    );
    const watcher = await watch(stale);
    assert.equal(watcher.socket.connected, true, "a ticket good for a second was refused early");

    await new Promise((done) => setTimeout(done, EXPIRY_MS));
    gateway.publish(FEED.device, { deviceId: "kiosk-e2e-stale", online: true });
    await new Promise((done) => setTimeout(done, SETTLE_MS));

    assert.deepEqual(watcher.heard, [], "an expired ticket was still being told things");
    assert.equal(watcher.socket.connected, false, "an expired ticket held the socket open");
    watcher.socket.close();
  });

  it("carries a punch to the manager above it and to nobody else", async () => {
    const boss = await watch(bossToken);
    const stranger = await watch(strangerToken);

    gateway.publish(FEED.attendance, { employeeId: underId, direction: "IN" }, underId);
    await new Promise((done) => setTimeout(done, SETTLE_MS));

    assert.equal(boss.heard.length, 1, "the manager above the punch was not told");
    assert.deepEqual(
      (boss.heard[0] as { employeeId: number }).employeeId,
      underId,
      "the manager heard about somebody else",
    );
    assert.deepEqual(stranger.heard, [], "a punch reached somebody outside the tree");
    boss.socket.close();
    stranger.socket.close();
  });
});
