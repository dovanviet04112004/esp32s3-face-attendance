import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Role } from "@prisma/client";
import { io, type Socket } from "socket.io-client";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { hashPassword } from "../src/modules/auth/password.js";
import { itemKey } from "../src/modules/notifications/notice-items.service.js";
import { FEED } from "../src/modules/realtime/realtime.gateway.js";

const RUN = randomUUID().slice(0, 6);
const PASSWORD = "e2e-notice-feed-password";
const PEOPLE = ["asker", "deskA", "deskB", "outsider"] as const;
type Who = (typeof PEOPLE)[number];
const ROLE: Record<Who, Role> = { asker: "EMPLOYEE", deskA: "HR", deskB: "HR", outsider: "MANAGER" };
const codeOf = (who: Who) => `E2ENF${PEOPLE.indexOf(who)}${RUN}`;
const mailOf = (who: Who) => `e2e-notice-feed-${who.toLowerCase()}-${RUN}@kiosk.local`;
const SETTLE_MS = 400;

type Message = Record<string, unknown>;

describe("who hears a notice on the feed (e2e)", () => {
  let app: INestApplication;
  let db: PrismaService;
  let port = 0;
  const tokenOf = new Map<Who, string>();
  const sockets: Socket[] = [];
  let deskAOther = "";
  let requestId = "";
  let rowIds = new Set<string>();

  function settle(): Promise<void> {
    return new Promise((done) => setTimeout(done, SETTLE_MS));
  }

  async function signIn(who: Who): Promise<string> {
    const res = await request(app.getHttpServer()).post("/auth/login").send({ email: mailOf(who), password: PASSWORD });
    assert.equal(res.status, 200, `${who} could not sign in`);
    return res.body.accessToken as string;
  }

  /** Open a socket and gather the notice messages it is told. */
  async function watch(token: string): Promise<Message[]> {
    const heard: Message[] = [];
    const socket = io(`http://127.0.0.1:${port}/feed`, { transports: ["websocket"], reconnection: false, auth: { token } });
    socket.on(FEED.notice, (body: Message) => heard.push(body));
    sockets.push(socket);
    await new Promise<void>((done) => socket.on("connect", () => done()));
    await settle();
    return heard;
  }

  // Other suites raise desk work at the same time, so a desk socket is read for this suite's request only.
  function about(heard: Message[]): Message[] {
    const key = itemKey("REQUESTS", requestId);
    return heard.filter((one) => (one.op === "new" && rowIds.has(String(one.id))) || (one.op === "item" && one.key === key));
  }

  async function sweep(): Promise<void> {
    await db.user.deleteMany({ where: { email: { in: PEOPLE.map(mailOf) } } });
    await db.employee.deleteMany({ where: { code: { in: PEOPLE.map(codeOf) } } });
  }

  before(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    await app.listen(0);
    port = (app.getHttpServer().address() as { port: number }).port;
    db = app.get(PrismaService);
    await sweep();
    for (const who of PEOPLE) {
      const made = await db.employee.create({ data: { code: codeOf(who), fullName: `Feed ${who} ${RUN}`, active: true } });
      await db.user.create({
        data: { email: mailOf(who), role: ROLE[who], employeeId: made.id, passwordHash: await hashPassword(PASSWORD) },
      });
      tokenOf.set(who, await signIn(who));
    }
    deskAOther = await signIn("deskA");
  });

  after(async () => {
    for (const socket of sockets) {
      socket.close();
    }
    await sweep();
    await app.close();
  });

  it("tells every device of each desk login of new work, and nobody outside its group", async () => {
    const [deskA, deskAPhone, deskB, outsider] = await Promise.all([
      watch(tokenOf.get("deskA") as string),
      watch(deskAOther),
      watch(tokenOf.get("deskB") as string),
      watch(tokenOf.get("outsider") as string),
    ]);
    const filed = await request(app.getHttpServer())
      .post("/requests")
      .set("Authorization", `Bearer ${tokenOf.get("asker")}`)
      .send({ kind: "REMOTE_WORK", fromDate: "2036-09-01", toDate: "2036-09-01", reason: "e2e" });
    assert.equal(filed.status, 201, JSON.stringify(filed.body));
    requestId = filed.body.id as string;
    const item = await db.noticeItem.findUniqueOrThrow({ where: { key: itemKey("REQUESTS", requestId) } });
    rowIds = new Set((await db.notification.findMany({ where: { itemId: item.id }, select: { id: true } })).map((one) => one.id));
    await settle();

    for (const [name, heard] of [["deskA", deskA], ["deskA's second device", deskAPhone], ["deskB", deskB]] as const) {
      const told = about(heard);
      assert.equal(told.length, 1, `${name} heard the new work other than once`);
      assert.equal(told[0].kind, "REQUEST_WAITING");
      assert.equal(told[0].category, "REQUESTS");
      assert.deepEqual(Object.keys(told[0]).sort(), ["category", "id", "kind", "op"], `${name} was told more than a reference`);
    }
    assert.deepEqual(outsider, [], "a manager outside the tree heard of the work");

    deskA.length = 0;
    deskAPhone.length = 0;
    deskB.length = 0;
    const decided = await request(app.getHttpServer())
      .post(`/requests/${requestId}/decide`)
      .set("Authorization", `Bearer ${tokenOf.get("deskB")}`)
      .send({ approve: true });
    assert.equal(decided.status, 201, JSON.stringify(decided.body));
    await settle();
    for (const [name, heard] of [["deskA", deskA], ["deskA's second device", deskAPhone], ["deskB", deskB]] as const) {
      const told = about(heard);
      assert.equal(told.length, 1, `${name} heard the close other than once`);
      assert.equal(told[0].op, "item");
      assert.equal(told[0].state, "DONE");
    }
    assert.deepEqual(outsider, [], "a manager outside the tree heard the work close");
  });

  it("tells a login's other devices of a read, not the device that read", async () => {
    const [here, there, deskB] = await Promise.all([
      watch(tokenOf.get("deskA") as string),
      watch(deskAOther),
      watch(tokenOf.get("deskB") as string),
    ]);
    const deskA = await db.user.findUniqueOrThrow({ where: { email: mailOf("deskA") } });
    const unread = await db.notification.create({
      data: { userId: deskA.id, kind: "PAYSLIP_ISSUED", dedupKey: `payslip-issued:row:${randomUUID()}` },
    });
    const read = await request(app.getHttpServer())
      .post("/notifications/read")
      .set("Authorization", `Bearer ${tokenOf.get("deskA")}`)
      .send({ ids: [unread.id] });
    assert.equal(read.status, 201, JSON.stringify(read.body));
    assert.equal(read.body.changed, 1);
    await settle();
    assert.equal(here.filter((one) => one.op === "read").length, 0, "the device that read heard its own read");
    assert.deepEqual(there.filter((one) => one.op === "read"), [{ op: "read", ids: [unread.id] }], "the other device missed the read");
    assert.equal(deskB.filter((one) => one.op === "read").length, 0, "somebody else heard a read");
  });
});
