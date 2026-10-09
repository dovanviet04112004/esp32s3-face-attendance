import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { Test } from "@nestjs/testing";
import type { Role } from "@prisma/client";
import request from "supertest";
import webpush from "web-push";

import { configure } from "../src/bootstrap.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { hashPassword } from "../src/modules/auth/password.js";
import { KIOSK_EVENT } from "../src/modules/mqtt/mqtt.events.js";
import { pushBody } from "../src/modules/notifications/dto/push-body.js";
import { itemKey, NoticeItemsService } from "../src/modules/notifications/notice-items.service.js";

// Push turns on with a key pair, and a one-second window keeps the desk's gathering inside a test.
// The config is read when AppModule loads, so the module is imported only after these are set.
const VAPID = webpush.generateVAPIDKeys();
process.env.VAPID_PUBLIC_KEY = VAPID.publicKey;
process.env.VAPID_PRIVATE_KEY = VAPID.privateKey;
process.env.NOTICE_PUSH_GATHER_SECONDS = "1";

const RUN = randomUUID().slice(0, 6);
const PASSWORD = "e2e-notice-push-password";
const PEOPLE = ["asker", "orphan", "boss", "desk"] as const;
type Who = (typeof PEOPLE)[number];
const ROLE: Record<Who, Role> = { asker: "EMPLOYEE", orphan: "EMPLOYEE", boss: "MANAGER", desk: "HR" };
const codeOf = (who: Who) => `E2ENP${PEOPLE.indexOf(who)}${RUN}`;
const mailOf = (who: Who) => `e2e-notice-push-${who}-${RUN}@kiosk.local`;
const endpointOf = (who: Who) => `https://fcm.googleapis.com/fcm/send/e2e-${who}-${RUN}`;
const WAIT_MS = 8000;
const POLL_MS = 100;
const DAY_MS = 86_400_000;
const DEVICE = `e2e-np-${RUN}`;
const SHIFT = `E2E NP ${RUN}`;
// Days no other suite builds: two the asker missed, one they only came late on.
const ABSENT_DAYS = ["2026-08-11", "2026-08-12"];
const LATE_DAY = "2026-08-13";

interface Sent {
  endpoint: string;
  body: Record<string, unknown>;
}

describe("pushes as references, one tag a piece of work, the desk's gathered (e2e)", () => {
  let app: INestApplication;
  let db: PrismaService;
  const sent: Sent[] = [];
  const gone = new Set<string>();
  const loginOf = new Map<Who, string>();
  const idOf = new Map<Who, number>();
  const tokenOf = new Map<Who, string>();
  let day = 0;
  let original: typeof webpush.sendNotification;

  const post = (who: Who, path: string, body: object = {}) =>
    request(app.getHttpServer()).post(path).set("Authorization", `Bearer ${tokenOf.get(who)}`).send(body);

  async function file(who: Who): Promise<string> {
    day += 1;
    const on = `2037-04-${String(day).padStart(2, "0")}`;
    const res = await post(who, "/requests", { kind: "REMOTE_WORK", fromDate: on, toDate: on, reason: "e2e" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.id as string;
  }

  async function pushesTo(who: Who, count: number): Promise<Sent[]> {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
      const mine = sent.filter((one) => one.endpoint === endpointOf(who));
      if (mine.length >= count || Date.now() > deadline) {
        return mine;
      }
      await new Promise((done) => setTimeout(done, POLL_MS));
    }
  }

  // A device's punches go with it, and they hold on to the people they are of.
  async function sweep(): Promise<void> {
    await db.device.deleteMany({ where: { id: DEVICE } });
    await db.user.deleteMany({ where: { email: { in: PEOPLE.map(mailOf) } } });
    await db.employee.deleteMany({ where: { code: { in: PEOPLE.map(codeOf) } } });
    await db.shift.deleteMany({ where: { name: SHIFT } });
  }

  before(async () => {
    original = webpush.sendNotification;
    webpush.sendNotification = (async (subscription: webpush.PushSubscription, payload?: string | Buffer | null) => {
      if (gone.has(subscription.endpoint)) {
        throw Object.assign(new Error("gone"), { statusCode: 410 });
      }
      sent.push({ endpoint: subscription.endpoint, body: JSON.parse(String(payload)) as Record<string, unknown> });
      return { statusCode: 201, body: "", headers: {} };
    }) as typeof webpush.sendNotification;
    const { AppModule } = await import("../src/app.module.js");
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    db = app.get(PrismaService);
    await sweep();
    for (const who of PEOPLE) {
      const made = await db.employee.create({ data: { code: codeOf(who), fullName: `Đẩy ${who} ${RUN}`, active: true } });
      idOf.set(who, made.id);
      const login = await db.user.create({
        data: { email: mailOf(who), role: ROLE[who], employeeId: made.id, passwordHash: await hashPassword(PASSWORD) },
      });
      loginOf.set(who, login.id);
      await db.pushSubscription.create({ data: { userId: login.id, endpoint: endpointOf(who), p256dh: "k", auth: "a" } });
    }
    await db.employee.update({ where: { id: idOf.get("asker") }, data: { managerId: idOf.get("boss") } });
    for (const who of PEOPLE) {
      const res = await request(app.getHttpServer()).post("/auth/login").send({ email: mailOf(who), password: PASSWORD });
      tokenOf.set(who, res.body.accessToken as string);
    }
  });

  after(async () => {
    webpush.sendNotification = original;
    await sweep();
    await app.close();
  });

  it("pushes a reference and a count, tagged by the work, and never a name", async () => {
    const id = await file("asker");
    const [waiting] = await pushesTo("boss", 1);
    assert.ok(waiting, "the manager got no push for work waiting on them");
    assert.deepEqual(Object.keys(pushBody.parse(waiting.body)).sort(), [
      "category",
      "count",
      "id",
      "kind",
      "locale",
      "renotify",
      "tag",
      "v",
    ]);
    assert.equal(waiting.body.kind, "REQUEST_WAITING");
    assert.equal(waiting.body.tag, itemKey("REQUESTS", id), "a piece of work is not tagged by its key");
    assert.equal(waiting.body.renotify, false);

    assert.equal((await post("boss", `/requests/${id}/decide`, { approve: true })).status, 201);
    const [decided] = await pushesTo("asker", 1);
    assert.ok(decided, "the asker got no push for the answer");
    const row = await db.notification.findFirstOrThrow({ where: { userId: loginOf.get("asker"), kind: "REQUEST_DECIDED", subjectId: id } });
    assert.equal(decided.body.id, row.id, "the push names some other row");
    assert.equal(decided.body.tag, row.dedupKey);
    assert.ok(!JSON.stringify(decided.body).includes(RUN), "a name reached the lock screen");
  });

  it("surfaces a reminder under the same tag and buzzes again", async () => {
    const id = await file("asker");
    await pushesTo("boss", 2);
    const before = sent.length;
    const items = app.get(NoticeItemsService);
    assert.ok(await items.claimMark("REQUESTS", id, 3));
    await items.remind("REQUESTS", id, { daysWaited: 3 });
    const reminded = (await pushesTo("boss", 3)).slice(-1)[0];
    assert.ok(sent.length > before && reminded, "the reminder pushed nothing");
    assert.equal(reminded.body.tag, itemKey("REQUESTS", id));
    assert.equal(reminded.body.renotify, true, "a reminder would not buzz a device that already shows the work");
    await post("asker", `/requests/${id}/cancel`);
  });

  it("gathers what reaches a desk login within the window into one push", async () => {
    const at = sent.length;
    await file("orphan");
    await file("orphan");
    await new Promise((done) => setTimeout(done, 1500));
    const desk = (await pushesTo("desk", 1)).filter((one) => sent.indexOf(one) >= at);
    assert.equal(desk.length, 1, "the desk got a push per piece of work instead of one");
    assert.equal(desk[0].body.count, 2);
    assert.equal(desk[0].body.tag, "gathered");
  });

  it("pushes nothing of a kind whose push the person turned off", async () => {
    assert.equal((await post("asker", "/notifications/preferences", { kind: "REQUEST_DECIDED", channel: "PUSH", on: false })).status, 201);
    const id = await file("asker");
    const at = (await pushesTo("asker", 0)).length;
    assert.equal((await post("boss", `/requests/${id}/decide`, { approve: false, note: "e2e" })).status, 201);
    await new Promise((done) => setTimeout(done, 1500));
    assert.equal((await pushesTo("asker", 0)).length, at, "a push the person turned off went out");
    const row = await db.notification.findFirst({ where: { userId: loginOf.get("asker"), kind: "REQUEST_DECIDED", subjectId: id } });
    assert.ok(row && row.archivedAt === null, "turning push off silenced the bell too");
  });

  it("drops a device the push service calls gone", async () => {
    gone.add(endpointOf("boss"));
    await file("asker");
    const deadline = Date.now() + WAIT_MS;
    while ((await db.pushSubscription.count({ where: { endpoint: endpointOf("boss") } })) > 0 && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, POLL_MS));
    }
    assert.equal(await db.pushSubscription.count({ where: { endpoint: endpointOf("boss") } }), 0, "a dead device stayed");
  });

  it("pushes a person's missing punches and absences once, together, at the morning sweep, and never their lateness", async () => {
    const { AttendanceSweep } = await import("../src/modules/notifications/sweeps/attendance.sweep.js");
    const attendance = app.get(AttendanceSweep);
    const asker = idOf.get("asker") ?? 0;
    await db.attendanceDay.createMany({
      data: [
        ...ABSENT_DAYS.map((day) => ({ employeeId: asker, date: new Date(day), state: "ABSENT" as const })),
        { employeeId: asker, date: new Date(LATE_DAY), state: "WORKED" as const, punchCount: 2, workedMinutes: 460, lateMinutes: 20 },
      ],
    });
    const at = sent.length;
    for (const day of [...ABSENT_DAYS, LATE_DAY]) {
      await attendance.afterBuild(day, asker);
    }
    await new Promise((done) => setTimeout(done, 1500));
    assert.equal(sent.length, at, "an exception pushed the moment the build opened it");
    await attendance.sweep();
    await attendance.sweep();
    const told = sent.slice(at).filter((one) => one.endpoint === endpointOf("asker") && one.body.kind === "ATTENDANCE_EXCEPTION");
    assert.equal(told.length, 1, "a person's exceptions were not pushed as one, once");
    assert.deepEqual([told[0].body.count, told[0].body.tag], [2, "gathered"], "lateness was pushed with the absences");
  });

  it("pushes a punch only once its person turns that on, with no row behind it", async () => {
    const bus = app.get(EventEmitter2);
    await db.device.create({ data: { id: DEVICE, status: "APPROVED" } });
    await db.deviceEnrollment.create({ data: { deviceId: DEVICE, employeeId: idOf.get("asker") as number, state: "ENROLLED" } });
    let local = 0;
    const arrive = async () => {
      local += 1;
      await bus.emitAsync(KIOSK_EVENT.attendance, {
        topic: "attendance",
        deviceId: DEVICE,
        receivedAt: new Date(),
        payload: { deviceId: DEVICE, localId: String(local), employeeId: idOf.get("asker"), ts: Date.now(), direction: "IN", matchScore: 0.9, livenessScore: 0.9, modelVersion: 1 },
      });
    };
    const before = (await pushesTo("asker", 0)).length;
    await arrive();
    await new Promise((done) => setTimeout(done, 1500));
    assert.equal((await pushesTo("asker", 0)).length, before, "a punch pushed before its person asked for it");
    assert.equal((await post("asker", "/notifications/preferences", { kind: "PUNCH_RECORDED", channel: "PUSH", on: true })).status, 201);
    await arrive();
    const punched = (await pushesTo("asker", before + 1)).slice(before);
    assert.equal(punched.length, 1, "the punch pushed nothing once its push was on");
    assert.deepEqual([punched[0].body.kind, punched[0].body.id, punched[0].body.tag], ["PUNCH_RECORDED", "", "punch-recorded"]);
    assert.equal(await db.notification.count({ where: { kind: "PUNCH_RECORDED" } }), 0, "a punch wrote a row");
  });

  it("gathers a person's shift changes into one push", async () => {
    const shift = await post("desk", "/shifts", { name: SHIFT, startTime: "08:00", endTime: "17:00", graceMinutes: 5 });
    assert.equal(shift.status, 201, JSON.stringify(shift.body));
    const before = (await pushesTo("asker", 0)).length;
    for (const days of [3, 4]) {
      const validFrom = new Date(Date.now() + days * DAY_MS).toISOString().slice(0, 10);
      const res = await post("desk", `/shifts/${shift.body.id}/assignments`, { employeeId: idOf.get("asker"), validFrom });
      assert.equal(res.status, 201, JSON.stringify(res.body));
    }
    await new Promise((done) => setTimeout(done, 1500));
    const told = (await pushesTo("asker", before + 1)).slice(before);
    assert.equal(told.length, 1, "each shift change buzzed the phone on its own");
    assert.deepEqual([told[0].body.kind, told[0].body.count, told[0].body.tag], ["SHIFT_CHANGED", 2, "gathered"]);
  });
});
