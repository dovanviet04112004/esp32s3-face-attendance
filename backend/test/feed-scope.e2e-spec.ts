import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { Test } from "@nestjs/testing";
import { io, type Socket } from "socket.io-client";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { AuthService } from "../src/modules/auth/auth.service.js";
import { hashPassword } from "../src/modules/auth/password.js";
import { FEED, RealtimeGateway, type FeedName } from "../src/modules/realtime/realtime.gateway.js";
import { paidLeaveType } from "./fixtures.js";
import { clearDeskNotices } from "./teardown.js";

const BOSS = "E2EFS01";
const UNDER = "E2EFS02";
const STRANGER = "E2EFS03";
const BOSS_MAIL = "e2efs-boss@kiosk.local";
const UNDER_MAIL = "e2efs-under@kiosk.local";
const STRANGER_MAIL = "e2efs-stranger@kiosk.local";
const PASSWORD = "kiosk-e2e-password";
const SETTLE_MS = 400;
// exp counts whole seconds, so a 2 s ticket lives between 1 and 2 s.
const TICKET_S = 2;
const EXPIRY_MS = 2500;
const LEAVE_FROM = "2026-12-21";
const LEAVE_TO = "2026-12-22";
const HOLIDAY_DATE = "2039-07-15";
const HOLIDAY_NAME = "E2E feed holiday";
const REPORT_RANGE = { from: "2020-01-01T00:00:00.000Z", to: "2020-01-02T00:00:00.000Z" };

interface Heard {
  feed: FeedName;
  body: Record<string, unknown>;
}

function changed(heard: Heard[], resource: string): boolean {
  return heard.some(
    (one) => one.feed === FEED.change && (one.body.resources as string[]).includes(resource),
  );
}

describe("who the feed talks to (e2e)", () => {
  let app: INestApplication;
  let db: PrismaService;
  let gateway: RealtimeGateway;
  let port = 0;
  let bossToken = "";
  let underToken = "";
  let strangerToken = "";
  let adminToken = "";
  let underId = 0;
  let leaveTypeId = "";
  let requestId = "";

  async function sweep(): Promise<void> {
    await clearDeskNotices(db, [UNDER]);
    await db.holiday.deleteMany({ where: { name: HOLIDAY_NAME } });
    await db.user.deleteMany({ where: { email: { in: [BOSS_MAIL, UNDER_MAIL, STRANGER_MAIL] } } });
    await db.employee.deleteMany({ where: { code: { in: [UNDER, BOSS, STRANGER] } } });
  }

  function settle(): Promise<void> {
    return new Promise((done) => setTimeout(done, SETTLE_MS));
  }

  /** Open a socket and gather what it is told, so a test can assert silence. */
  async function watch(token?: string): Promise<{ heard: Heard[]; socket: Socket }> {
    const heard: Heard[] = [];
    const socket = io(`http://127.0.0.1:${port}/feed`, {
      transports: ["websocket"],
      reconnection: false,
      ...(token ? { auth: { token } } : {}),
    });
    for (const feed of Object.values(FEED)) {
      socket.on(feed, (body: Record<string, unknown>) => heard.push({ feed, body }));
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

    const template = await db.employee.findFirstOrThrow({ where: { active: true } });
    const placed = { departmentId: template.departmentId, legalEntityId: template.legalEntityId };
    const boss = await db.employee.create({
      data: { code: BOSS, fullName: "Quản lý feed", active: true, ...placed },
    });
    const under = await db.employee.create({
      data: { code: UNDER, fullName: "Cấp dưới feed", active: true, managerId: boss.id, ...placed },
    });
    underId = under.id;
    leaveTypeId = (await paidLeaveType(db)).id;
    await db.leaveBalance.create({
      data: { employeeId: under.id, leaveTypeId, year: 2026, entitled: 12 },
    });
    const stranger = await db.employee.create({
      data: { code: STRANGER, fullName: "Người ngoài feed", active: true },
    });
    const passwordHash = await hashPassword(PASSWORD);
    await db.user.create({
      data: { email: BOSS_MAIL, passwordHash, role: "MANAGER", employeeId: boss.id },
    });
    await db.user.create({
      data: { email: UNDER_MAIL, passwordHash, role: "EMPLOYEE", employeeId: under.id },
    });
    await db.user.create({
      data: { email: STRANGER_MAIL, passwordHash, role: "EMPLOYEE", employeeId: stranger.id },
    });
    // Through the service: the login door is counted by the minute and this
    // suite would spend the allowance on setup.
    const auth = app.get(AuthService);
    bossToken = (await auth.signIn(BOSS_MAIL, PASSWORD, {})).accessToken;
    underToken = (await auth.signIn(UNDER_MAIL, PASSWORD, {})).accessToken;
    strangerToken = (await auth.signIn(STRANGER_MAIL, PASSWORD, {})).accessToken;
    const seeded = validateEnv().SEED_ADMIN_PASSWORD ?? "";
    adminToken = (await auth.signIn("admin@kiosk.local", seeded, {})).accessToken;
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
      { secret: validateEnv().JWT_ACCESS_SECRET, expiresIn: TICKET_S },
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
    assert.deepEqual(boss.heard[0].body.employeeId, underId, "the manager heard about somebody else");
    assert.deepEqual(stranger.heard, [], "a punch reached somebody outside the tree");
    boss.socket.close();
    stranger.socket.close();
  });
  it("tells the tree a request was filed, and the manager's bell that it waits", async () => {
    const boss = await watch(bossToken);
    const under = await watch(underToken);
    const stranger = await watch(strangerToken);

    const filed = await request(app.getHttpServer())
      .post("/requests")
      .set("Authorization", `Bearer ${underToken}`)
      .send({ kind: "LEAVE", leaveTypeId, fromDate: LEAVE_FROM, toDate: LEAVE_TO, reason: "e2e" });
    assert.equal(filed.status, 201, JSON.stringify(filed.body));
    requestId = filed.body.id;
    await settle();

    assert.ok(changed(under.heard, "requests"), "the person who filed it was not told");
    assert.ok(changed(boss.heard, "requests"), "the manager it waits on was not told");
    const waiting = boss.heard.find((one) => one.feed === FEED.notice);
    assert.equal(waiting?.body.kind, "REQUEST_WAITING", "the manager's bell was not told");
    assert.deepEqual(stranger.heard, [], "a request reached somebody outside the tree");
    for (const one of [boss, under, stranger]) {
      one.socket.close();
    }
  });

  it("shows the person who asked the answer the moment it is given", async () => {
    const under = await watch(underToken);
    const stranger = await watch(strangerToken);

    const decided = await request(app.getHttpServer())
      .post(`/requests/${requestId}/decide`)
      .set("Authorization", `Bearer ${bossToken}`)
      .send({ approve: false, note: "e2e" });
    assert.equal(decided.status, 201, JSON.stringify(decided.body));
    await settle();

    assert.ok(changed(under.heard, "requests"), "the open request list was not told");
    const answer = under.heard.find((one) => one.feed === FEED.notice);
    assert.equal(answer?.body.kind, "REQUEST_DECIDED", "the bell was not told");
    assert.equal(answer?.body.requestId, requestId);
    assert.equal(answer?.body.approved, false);
    assert.deepEqual(stranger.heard, [], "an answer reached somebody outside the tree");
    under.socket.close();
    stranger.socket.close();
  });

  it("keeps reading one's own notices to that one login", async () => {
    const under = await watch(underToken);
    const boss = await watch(bossToken);

    const read = await request(app.getHttpServer())
      .post("/notifications/read")
      .set("Authorization", `Bearer ${underToken}`);
    assert.equal(read.status, 201);
    await settle();

    assert.ok(changed(under.heard, "notifications"), "the reader's other tabs were not told");
    assert.deepEqual(boss.heard, [], "somebody else's bell heard about a read");
    under.socket.close();
    boss.socket.close();
  });

  it("keeps a write nobody owns to the roles that see everyone", async () => {
    const admin = await watch(adminToken);
    const boss = await watch(bossToken);
    const stranger = await watch(strangerToken);

    const queued = await request(app.getHttpServer())
      .post("/reports/attendance/monthly")
      .set("Authorization", `Bearer ${adminToken}`)
      .send(REPORT_RANGE);
    assert.equal(queued.status, 201);
    await settle();

    assert.ok(changed(admin.heard, "reports"), "the admin was not told");
    assert.deepEqual(boss.heard, [], "a manager heard about a row nobody owns");
    assert.deepEqual(stranger.heard, [], "an employee heard about a row nobody owns");
    for (const one of [admin, boss, stranger]) {
      one.socket.close();
    }
  });

  it("tells everyone about a table everyone reads", async () => {
    const stranger = await watch(strangerToken);

    const added = await request(app.getHttpServer())
      .post("/holidays")
      .set("Authorization", `Bearer ${adminToken}`)
      .send({ date: HOLIDAY_DATE, name: HOLIDAY_NAME });
    assert.equal(added.status, 201, JSON.stringify(added.body));
    await settle();

    assert.ok(changed(stranger.heard, "holidays"), "an employee was not told the holidays moved");
    stranger.socket.close();
  });

  it("tells a manager about a new report filed under them, though the socket predates the row", async () => {
    const newcomer = "E2EFS04";
    const boss = await watch(bossToken);
    const stranger = await watch(strangerToken);
    const above = await db.employee.findUniqueOrThrow({ where: { code: BOSS } });
    await db.employee.deleteMany({ where: { code: newcomer } });
    try {
      const made = await request(app.getHttpServer())
        .post("/employees")
        .set("Authorization", `Bearer ${adminToken}`)
        .send({ code: newcomer, fullName: "Người mới feed", managerId: above.id });
      assert.equal(made.status, 201, JSON.stringify(made.body));
      await settle();

      assert.ok(changed(boss.heard, "employees"), "the manager's open team list missed the new report");
      assert.deepEqual(stranger.heard, [], "a new employee reached somebody outside the tree");
    } finally {
      boss.socket.close();
      stranger.socket.close();
      await db.employee.deleteMany({ where: { code: newcomer } });
    }
  });
});
