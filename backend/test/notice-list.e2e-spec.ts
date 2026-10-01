import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { Prisma, Role } from "@prisma/client";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { hashPassword } from "../src/modules/auth/password.js";

const RUN = randomUUID().slice(0, 6);
const PASSWORD = "e2e-notice-list-password";
const PEOPLE = ["reader", "other", "plain", "crowd", "needle"] as const;
type Who = (typeof PEOPLE)[number];
const ROLE: Record<Who, Role> = { reader: "HR", other: "HR", plain: "EMPLOYEE", crowd: "EMPLOYEE", needle: "EMPLOYEE" };
const codeOf = (who: Who) => `E2ENL${PEOPLE.indexOf(who)}${RUN}`;
const mailOf = (who: Who) => `e2e-notice-list-${who}-${RUN}@kiosk.local`;
const CROWD = 5_000;
const MINUTE_MS = 60_000;

interface Row {
  id: string;
  kind: string;
  category: string;
  readAt: string | null;
  archivedAt: string | null;
  requestId: string | null;
  subject: { type: string; id: string | null; hidden: boolean; person: { code: string } | null } | null;
  item: { key: string; state: string } | null;
}

interface PageBody {
  rows: Row[];
  total: number;
  totalIsExact: boolean;
  next: string | null;
}

describe("the bell's list, counts and marks (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  const idOf = new Map<Who, number>();
  const loginOf = new Map<Who, string>();
  const tokenOf = new Map<Who, string>();
  let adminToken = "";
  let needleRequest = "";
  let itemKey = "";

  const get = (who: Who, path: string) => request(http).get(path).set("Authorization", `Bearer ${tokenOf.get(who)}`);
  const post = (who: Who, path: string, body: object) =>
    request(http).post(path).set("Authorization", `Bearer ${tokenOf.get(who)}`).send(body);

  // A decided request about someone, as the old bell wrote them: subject, key and the reference the bell still reads.
  function decided(userId: string, about: Who, at: Date, requestId: string = randomUUID()): Prisma.NotificationCreateManyInput {
    return {
      userId,
      kind: "REQUEST_DECIDED",
      subjectType: "REQUEST",
      subjectId: requestId,
      subjectEmployeeId: idOf.get(about),
      requestId,
      approved: true,
      facts: { outcome: "APPROVED" },
      dedupKey: `request-decided:request:${requestId}`,
      createdAt: at,
    };
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
    await sweep();
    for (const who of PEOPLE) {
      const made = await db.employee.create({ data: { code: codeOf(who), fullName: `Danh sách ${who} ${RUN}`, active: true } });
      idOf.set(who, made.id);
      const login = await db.user.create({
        data: { email: mailOf(who), role: ROLE[who], employeeId: made.id, passwordHash: await hashPassword(PASSWORD) },
      });
      loginOf.set(who, login.id);
    }
    for (const who of PEOPLE) {
      const res = await request(http).post("/auth/login").send({ email: mailOf(who), password: PASSWORD });
      assert.equal(res.status, 200, `${who} could not sign in`);
      tokenOf.set(who, res.body.accessToken as string);
    }
    const admin = await request(http)
      .post("/auth/login")
      .send({ email: "admin@kiosk.local", password: validateEnv().SEED_ADMIN_PASSWORD ?? "" });
    adminToken = admin.body.accessToken as string;

    const reader = loginOf.get("reader") as string;
    const start = Date.now() - (CROWD + 10) * MINUTE_MS;
    const rows = Array.from({ length: CROWD }, (_, at) => decided(reader, "crowd", new Date(start + at * MINUTE_MS)));
    needleRequest = randomUUID();
    rows[1234] = decided(reader, "needle", new Date(start + 1234 * MINUTE_MS), needleRequest);
    for (let at = 0; at < rows.length; at += 1000) {
      await db.notification.createMany({ data: rows.slice(at, at + 1000) });
    }
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("pages five thousand rows with a total and a cursor, newest first", async () => {
    const first = await get("reader", "/notifications?take=50");
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const page = first.body as PageBody;
    assert.equal(page.rows.length, 50);
    assert.equal(page.total, CROWD);
    assert.equal(page.totalIsExact, true);
    assert.ok(page.next, "a full page gave no way to the next");
    const second = (await get("reader", `/notifications?take=50&cursor=${page.next}`)).body as PageBody;
    assert.equal(second.rows.length, 50);
    const seen = new Set(page.rows.map((row) => row.id));
    assert.ok(second.rows.every((row) => !seen.has(row.id)), "the second page repeated a row");
    assert.equal(page.rows[0].category, "REQUESTS");
  });

  it("finds the one row about a person among five thousand by their code", async () => {
    const res = await get("reader", `/notifications?search=${codeOf("needle")}`);
    const page = res.body as PageBody;
    assert.equal(page.total, 1, "the search did not narrow to the one row");
    assert.equal(page.rows[0].requestId, needleRequest);
    assert.equal(page.rows[0].subject?.person?.code, codeOf("needle"));
  });

  it("narrows by category and by day", async () => {
    const pay = (await get("reader", "/notifications?category=PAY")).body as PageBody;
    assert.equal(pay.total, 0, "a pay filter listed requests");
    const far = (await get("reader", "/notifications?from=2001-01-01&to=2001-01-02")).body as PageBody;
    assert.equal(far.total, 0, "a day range listed rows outside it");
  });

  it("counts what the bell shows, the work held, and the critical work held", async () => {
    const reader = loginOf.get("reader") as string;
    const subjectId = randomUUID();
    itemKey = `requests:${subjectId}`;
    const item = await db.noticeItem.create({
      data: { key: itemKey, queue: "REQUESTS", subjectType: "REQUEST", subjectId, employeeId: idOf.get("plain") },
    });
    await db.notification.create({
      data: {
        userId: reader,
        kind: "REQUEST_WAITING",
        itemId: item.id,
        subjectType: "REQUEST",
        subjectId,
        subjectEmployeeId: idOf.get("plain"),
        requestId: subjectId,
        dedupKey: itemKey,
      },
    });
    const counts = (await get("reader", "/notifications/counts")).body as { unread: number; action: number; critical: number };
    assert.equal(counts.unread, CROWD + 1);
    assert.equal(counts.action, 1);
    assert.equal(counts.critical, 0);
    const action = (await get("reader", "/notifications?status=action")).body as PageBody;
    assert.deepEqual(action.rows.map((row) => row.item?.key), [itemKey]);
  });

  it("marks by ids, never touching another account's rows", async () => {
    const mine = ((await get("reader", "/notifications?take=1")).body as PageBody).rows[0];
    const theirs = await db.notification.create({ data: decided(loginOf.get("other") as string, "crowd", new Date()) });
    const res = await post("reader", "/notifications/read", { ids: [mine.id, theirs.id] });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.changed, 1, "a row of another account changed");
    assert.equal((await db.notification.findUniqueOrThrow({ where: { id: theirs.id } })).readAt, null);
    assert.equal((await post("reader", "/notifications/unread", { ids: [mine.id] })).body.changed, 1);
  });

  it("marks every row about one record, as its page does on opening", async () => {
    const res = await post("reader", "/notifications/read", { subject: { type: "REQUEST", id: needleRequest } });
    assert.equal(res.body.changed, 1);
    const row = await db.notification.findFirstOrThrow({ where: { userId: loginOf.get("reader"), requestId: needleRequest } });
    assert.ok(row.readAt);
  });

  it("puts away every row the filter in view selects, and only those", async () => {
    const res = await post("reader", "/notifications/archive", { all: true, search: codeOf("needle") });
    assert.equal(res.body.changed, 1);
    const archived = (await get("reader", "/notifications?status=archived")).body as PageBody;
    assert.deepEqual(archived.rows.map((row) => row.requestId), [needleRequest]);
    assert.equal(((await get("reader", "/notifications")).body as PageBody).total, CROWD, "the put-away row still listed");
    assert.equal((await post("reader", "/notifications/unarchive", { all: true, status: "archived" })).body.changed, 1);
  });

  it("takes exactly one way of naming rows", async () => {
    for (const body of [{}, { all: true, ids: [randomUUID()] }]) {
      const res = await post("reader", "/notifications/read", body);
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.equal(res.body.message, "SELECTION_INVALID");
    }
  });

  it("reads one row of one's own, and no one else's", async () => {
    const mine = ((await get("reader", "/notifications?take=1")).body as PageBody).rows[0];
    assert.equal((await get("reader", `/notifications/${mine.id}`)).status, 200);
    const res = await get("other", `/notifications/${mine.id}`);
    assert.equal(res.status, 404);
    assert.equal(res.body.message, "NOTICE_NOT_FOUND");
  });

  it("hides a person the reader may no longer see, and keeps the search from finding them", async () => {
    await db.notification.create({ data: decided(loginOf.get("plain") as string, "needle", new Date()) });
    const page = (await get("plain", "/notifications")).body as PageBody;
    const about = page.rows.find((row) => row.kind === "REQUEST_DECIDED");
    assert.equal(about?.subject?.hidden, true, "an employee saw a name outside their reach");
    assert.equal(about?.subject?.person, null);
    assert.equal(about?.requestId, null, "a hidden subject left its id behind");
    assert.equal(((await get("plain", `/notifications?search=${codeOf("needle")}`)).body as PageBody).total, 0);
  });

  it("lists one's own push devices without their keys, and drops only one's own", async () => {
    const mine = await db.pushSubscription.create({
      data: { userId: loginOf.get("reader") as string, endpoint: `https://fcm.googleapis.com/fcm/send/list-${RUN}`, p256dh: "k", auth: "a" },
    });
    const listed = await get("reader", "/notifications/subscriptions");
    assert.equal(listed.status, 200);
    assert.ok((listed.body as { id: string }[]).some((one) => one.id === mine.id));
    assert.ok((listed.body as object[]).every((one) => !("auth" in one) && !("p256dh" in one)), "a device key left the server");
    const stranger = await request(http).delete(`/notifications/subscriptions/${mine.id}`).set("Authorization", `Bearer ${tokenOf.get("other")}`);
    assert.equal(stranger.status, 404);
    const dropped = await request(http).delete(`/notifications/subscriptions/${mine.id}`).set("Authorization", `Bearer ${tokenOf.get("reader")}`);
    assert.equal(dropped.status, 200);
    assert.equal(await db.pushSubscription.count({ where: { id: mine.id } }), 0);
  });

  it("runs a sweep now for an administrator, and for nobody else", async () => {
    const refused = await post("reader", "/notifications/sweeps/contracts", {});
    assert.equal(refused.status, 403);
    const unknown = await request(http).post("/notifications/sweeps/everything").set("Authorization", `Bearer ${adminToken}`);
    assert.equal(unknown.status, 400);
    const ran = await request(http).post("/notifications/sweeps/contracts").set("Authorization", `Bearer ${adminToken}`);
    assert.equal(ran.status, 201, JSON.stringify(ran.body));
    assert.equal(ran.body.name, "contracts");
    assert.equal(typeof ran.body.result.told, "number");
  });
});
