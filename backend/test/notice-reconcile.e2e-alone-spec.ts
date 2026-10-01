import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Role } from "@prisma/client";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { hashPassword } from "../src/modules/auth/password.js";
import { INBOX_QUEUES } from "../src/modules/notifications/audience.service.js";
import { itemKey } from "../src/modules/notifications/notice-items.service.js";
import { ReconcileSweep } from "../src/modules/notifications/sweeps/reconcile.sweep.js";

const RUN = randomUUID().slice(0, 6);
const PASSWORD = "e2e-reconcile-password";
const PEOPLE = ["asker", "boss", "standIn"] as const;
type Who = (typeof PEOPLE)[number];
const ROLE: Record<Who, Role> = { asker: "EMPLOYEE", boss: "MANAGER", standIn: "MANAGER" };
const codeOf = (who: Who) => `E2ERC${PEOPLE.indexOf(who)}${RUN}`;
const mailOf = (who: Who) => `e2e-reconcile-${who.toLowerCase()}-${RUN}@kiosk.local`;
const DAY_MS = 86_400_000;

describe("the hourly reconcile, run after every other suite (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let reconcile: ReconcileSweep;
  const idOf = new Map<Who, number>();
  const loginOf = new Map<Who, string>();
  let askerToken = "";
  let day = 0;

  async function file(): Promise<string> {
    day += 1;
    const on = `2037-02-${String(day).padStart(2, "0")}`;
    const res = await request(http)
      .post("/requests")
      .set("Authorization", `Bearer ${askerToken}`)
      .send({ kind: "REMOTE_WORK", fromDate: on, toDate: on, reason: "e2e" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.id as string;
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
    http = app.getHttpServer();
    db = app.get(PrismaService);
    reconcile = app.get(ReconcileSweep);
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("finds no item a write path forgot to open or close in what the other suites left", async () => {
    const admin = await request(http)
      .post("/auth/login")
      .send({ email: "admin@kiosk.local", password: validateEnv().SEED_ADMIN_PASSWORD ?? "" });
    const res = await request(http)
      .post("/notifications/sweeps/reconcile")
      .set("Authorization", `Bearer ${admin.body.accessToken}`);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const tally = res.body.result as Record<string, { closed: number; opened: number }>;
    for (const queue of INBOX_QUEUES) {
      const one = tally[queue];
      assert.equal(one.closed, 0, `${queue}: an item stayed open after its business row was done`);
      assert.equal(one.opened, 0, `${queue}: a waiting row had no item`);
    }
  });

  it("closes once an item whose business row changed behind the write path", async () => {
    await sweep();
    for (const who of PEOPLE) {
      const made = await db.employee.create({ data: { code: codeOf(who), fullName: `Đối soát ${who}`, active: true } });
      idOf.set(who, made.id);
      const login = await db.user.create({
        data: { email: mailOf(who), role: ROLE[who], employeeId: made.id, passwordHash: await hashPassword(PASSWORD) },
      });
      loginOf.set(who, login.id);
    }
    await db.employee.update({ where: { id: idOf.get("asker") }, data: { managerId: idOf.get("boss") } });
    const signedIn = await request(http).post("/auth/login").send({ email: mailOf("asker"), password: PASSWORD });
    askerToken = signedIn.body.accessToken as string;

    const id = await file();
    await db.request.update({
      where: { id },
      data: { state: "APPROVED", decidedById: loginOf.get("boss"), decidedAt: new Date() },
    });
    const first = await reconcile.sweep();
    assert.equal(first.REQUESTS.closed, 1);
    const item = await db.noticeItem.findUniqueOrThrow({ where: { key: itemKey("REQUESTS", id) } });
    assert.equal(item.state, "DONE");
    assert.equal(item.outcome, "APPROVED");
    assert.equal(item.actorId, loginOf.get("boss"), "the item does not name who decided on the business row");
    assert.equal(await db.notification.count({ where: { itemId: item.id, readAt: null } }), 0);
    assert.equal((await reconcile.sweep()).REQUESTS.closed, 0, "the same item closed twice");
  });

  it("opens the item a waiting row never got, its group finding it already read", async () => {
    const today = new Date(new Date().toISOString().slice(0, 10));
    const made = await db.request.create({
      data: {
        employeeId: idOf.get("asker") as number,
        approverId: idOf.get("boss") as number,
        kind: "REMOTE_WORK",
        state: "PENDING",
        fromDate: today,
        toDate: today,
        reason: "e2e",
      },
    });
    const tally = await reconcile.sweep();
    assert.equal(tally.REQUESTS.opened, 1);
    const item = await db.noticeItem.findUniqueOrThrow({ where: { key: itemKey("REQUESTS", made.id) } });
    assert.equal(item.state, "OPEN");
    const seat = await db.notification.findFirst({ where: { itemId: item.id, userId: loginOf.get("boss") } });
    assert.ok(seat?.readAt, "work found by the reconcile arrived unread, as news it is not");
    assert.equal((await reconcile.sweep()).REQUESTS.opened, 0, "the same item opened twice");
  });

  it("seats a stand-in whose cover began, without a sound", async () => {
    const id = await file();
    const item = await db.noticeItem.findUniqueOrThrow({ where: { key: itemKey("REQUESTS", id) } });
    const today = new Date(new Date().toISOString().slice(0, 10));
    await db.approvalDelegation.create({
      data: {
        fromId: idOf.get("boss") as number,
        toId: idOf.get("standIn") as number,
        fromDate: new Date(today.getTime() - DAY_MS),
        toDate: new Date(today.getTime() + DAY_MS),
      },
    });
    const tally = await reconcile.sweep();
    assert.ok(tally.REQUESTS.joined >= 1, "a stand-in whose cover began was not seated");
    const seat = await db.notification.findFirst({ where: { itemId: item.id, userId: loginOf.get("standIn") } });
    assert.ok(seat?.readAt, "the stand-in's seat arrived unread");
  });
});
