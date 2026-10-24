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
import { NotificationsService } from "../src/modules/notifications/notifications.service.js";
import { QUEUE_TOKEN, type Queues } from "../src/queue/queue.module.js";
import { JOB, QUEUE, type NoticeFanoutJob } from "../src/queue/queues.js";
import { seedEntityId } from "./fixtures.js";

// Push turns on with a key pair, and a one-second window keeps the desk's gathering inside a test.
// The config is read when AppModule loads, so the module is imported only after these are set.
const VAPID = webpush.generateVAPIDKeys();
process.env.VAPID_PUBLIC_KEY = VAPID.publicKey;
process.env.VAPID_PRIVATE_KEY = VAPID.privateKey;
process.env.NOTICE_PUSH_GATHER_SECONDS = "1";

const RUN = randomUUID().slice(0, 6);
const PASSWORD = "e2e-notice-push-password";
const PEOPLE = ["asker", "orphan", "boss", "desk", "admin"] as const;
type Who = (typeof PEOPLE)[number];
const ROLE: Record<Who, Role> = { asker: "EMPLOYEE", orphan: "EMPLOYEE", boss: "MANAGER", desk: "HR", admin: "ADMIN" };
const codeOf = (who: Who) => `E2ENP${PEOPLE.indexOf(who)}${RUN}`;
const mailOf = (who: Who) => `e2e-notice-push-${who}-${RUN}@kiosk.local`;
const endpointOf = (who: Who) => `https://fcm.googleapis.com/fcm/send/e2e-${who}-${RUN}`;
const WAIT_MS = 8000;
const POLL_MS = 100;
const HANG_MS = 60_000;
const DAY_MS = 86_400_000;
const DEVICE = `e2e-np-${RUN}`;
const KIOSK = `e2e-npk-${RUN}`;
const SHIFT = `E2E NP ${RUN}`;
// Days no other suite builds: two the asker missed, one they only came late on, one the orphan missed.
const ABSENT_DAYS = ["2026-08-11", "2026-08-12"];
const LATE_DAY = "2026-08-13";
const QUIET_DAY = "2026-08-14";

interface Sent {
  endpoint: string;
  body: Record<string, unknown>;
}

describe("pushes as references, one tag a piece of work, the desk's gathered (e2e)", () => {
  let app: INestApplication;
  let db: PrismaService;
  const sent: Sent[] = [];
  const gone = new Set<string>();
  // Status codes an endpoint answers, one a send, then it takes pushes again.
  const refusing = new Map<string, number[]>();
  const tried = new Map<string, number>();
  // Endpoints that never answer: web-push gives up on them only when handed a timeout.
  const mute = new Set<string>();
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

  async function until(check: () => Promise<boolean>, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!(await check())) {
      assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
      await new Promise((done) => setTimeout(done, POLL_MS));
    }
  }

  // A device's punches go with it, and they hold on to the people they are of.
  async function sweep(): Promise<void> {
    await db.noticeItem.deleteMany({ where: { queue: "KIOSK", subjectId: KIOSK } });
    await db.device.deleteMany({ where: { id: { in: [DEVICE, KIOSK] } } });
    await db.user.deleteMany({ where: { email: { in: PEOPLE.map(mailOf) } } });
    await db.employee.deleteMany({ where: { code: { in: PEOPLE.map(codeOf) } } });
    await db.shift.deleteMany({ where: { name: { startsWith: SHIFT } } });
  }

  before(async () => {
    original = webpush.sendNotification;
    webpush.sendNotification = (async (
      subscription: webpush.PushSubscription,
      payload?: string | Buffer | null,
      options?: webpush.RequestOptions,
    ) => {
      tried.set(subscription.endpoint, (tried.get(subscription.endpoint) ?? 0) + 1);
      if (mute.has(subscription.endpoint)) {
        if (options?.timeout) {
          throw new Error("Socket timeout");
        }
        await new Promise((done) => setTimeout(done, HANG_MS));
      }
      if (gone.has(subscription.endpoint)) {
        throw Object.assign(new Error("gone"), { statusCode: 410 });
      }
      const refusal = refusing.get(subscription.endpoint)?.shift();
      if (refusal !== undefined) {
        throw Object.assign(new Error("refused"), { statusCode: refusal });
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
    const entityId = await seedEntityId(db);
    for (const who of PEOPLE) {
      const made = await db.employee.create({
        data: { code: codeOf(who), fullName: `Đẩy ${who} ${RUN}`, active: true, legalEntityId: entityId },
      });
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
    assert.equal(desk[0].body.gathered, "work", "two requests waiting were not told as work");
  });

  it("opens the desk's next window after a gather that failed for good", async () => {
    const notices = app.get(NotificationsService);
    const queue = (app.get(QUEUE_TOKEN) as Queues)[QUEUE.notify];
    const desk = loginOf.get("desk") as string;
    const held = notices.gather;
    let tries = 0;
    notices.gather = async (userId: string) => {
      tries += userId === desk ? 1 : 0;
      throw new Error("e2e: the gather fell over");
    };
    try {
      await file("orphan");
      await until(async () => tries >= 3 && (await queue.getDeduplicationJobId(`gather-${desk}`)) === null, "the gather failing for good");
    } finally {
      notices.gather = held;
    }
    const before = (await pushesTo("desk", 0)).length;
    await file("orphan");
    assert.equal((await pushesTo("desk", before + 1)).length, before + 1, "a failed gather swallowed the desk's next window");
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

  it("tries again only the devices a push service put off, for a bounded number of rounds, and never one it refused", async () => {
    const queue = (app.get(QUEUE_TOKEN) as Queues)[QUEUE.notify];
    const orphan = loginOf.get("orphan") as string;
    const [busy, down, bad] = ["busy", "down", "bad"].map((name) => `${endpointOf("orphan")}-${name}`);
    const subOf = new Map<string, string>();
    for (const endpoint of [busy, down, bad]) {
      subOf.set(endpoint, (await db.pushSubscription.create({ data: { userId: orphan, endpoint, p256dh: "k", auth: "a" } })).id);
    }
    refusing.set(busy, [503]);
    refusing.set(down, [500, 500, 500, 500, 500]);
    refusing.set(bad, [400]);
    const to = (endpoint: string) => sent.filter((one) => one.endpoint === endpoint).length;
    const retry = async () => {
      const deadline = Date.now() + 2000;
      for (;;) {
        const held = (await queue.getDelayed()).find(
          (job) => job.name === JOB.noticeFanout && (job.data as NoticeFanoutJob).rows.some((row) => row.userId === orphan),
        );
        if (held || Date.now() > deadline) {
          return held;
        }
        await new Promise((done) => setTimeout(done, POLL_MS));
      }
    };

    const before = to(endpointOf("orphan"));
    const id = await file("orphan");
    assert.equal((await post("desk", `/requests/${id}/decide`, { approve: true })).status, 201);
    await until(async () => to(endpointOf("orphan")) > before, "the push of the decision");
    let job = await retry();
    assert.ok(job, "nothing waited to go again after a push service put two devices off");
    assert.deepEqual(
      (job.data as NoticeFanoutJob).rows.map((row) => [...(row.subscriptions ?? [])].sort()),
      [[subOf.get(busy), subOf.get(down)].sort()],
      "the retry holds other than the devices put off",
    );
    while (job) {
      const tries = tried.get(down) ?? 0;
      await job.promote();
      await until(async () => (tried.get(down) ?? 0) > tries, "a retry going out");
      job = await retry();
    }
    assert.equal(to(busy), 1, "a device put off once never got its push");
    assert.equal(tried.get(down), 4, "a device always put off was not tried once and three rounds more");
    assert.equal(tried.get(bad), 1, "a device refused for its request was tried again");
    assert.equal(to(endpointOf("orphan")), before + 1, "a device that took the push got it again");
    assert.equal(await db.pushSubscription.count({ where: { endpoint: bad } }), 1, "a refused device was dropped as if dead");
  });

  it("gives up on a push service that never answers, so the pushes queued behind it still go", async () => {
    const silent = `${endpointOf("orphan")}-silent`;
    await db.pushSubscription.create({ data: { userId: loginOf.get("orphan") as string, endpoint: silent, p256dh: "k", auth: "a" } });
    mute.add(silent);
    try {
      const before = (await pushesTo("desk", 0)).length;
      const id = await file("orphan");
      assert.equal((await post("desk", `/requests/${id}/decide`, { approve: true })).status, 201);
      await file("orphan");
      assert.equal((await pushesTo("desk", before + 1)).length, before + 1, "a push service that never answered held up every push after it");
    } finally {
      mute.delete(silent);
      await db.pushSubscription.deleteMany({ where: { endpoint: silent } });
    }
  });

  it("counts in a desk's window only what waited in it, never a CRITICAL notice that went alone", async () => {
    const queue = (app.get(QUEUE_TOKEN) as Queues)[QUEUE.notify];
    await until(async () => (await queue.getDeduplicationJobId(`gather-${loginOf.get("admin")}`)) === null, "an earlier window");
    await db.device.create({ data: { id: KIOSK, status: "APPROVED", online: true } });
    const before = (await pushesTo("admin", 0)).length;
    const id = await file("orphan");
    await app
      .get(NoticeItemsService)
      .open("KIOSK", { id: KIOSK, part: "camera-fault", employeeId: null }, { level: "CRITICAL", facts: { code: "CAMERA_FAULT" } });
    await new Promise((done) => setTimeout(done, 1500));
    const told = (await pushesTo("admin", before + 2)).slice(before);
    assert.deepEqual(told.map((one) => one.body.kind).sort(), ["KIOSK_ALERT", "REQUEST_WAITING"], "the window took in the CRITICAL notice");
    const waited = told.find((one) => one.body.kind === "REQUEST_WAITING");
    assert.deepEqual([waited?.body.count, waited?.body.tag], [1, itemKey("REQUESTS", id)], "the window counted a notice pushed alone");
  });

  it("counts in a person's window only what waited in it, never a kind pushed at once or a row opened without a sound", async () => {
    const { AttendanceSweep } = await import("../src/modules/notifications/sweeps/attendance.sweep.js");
    const orphan = idOf.get("orphan") as number;
    await db.attendanceDay.create({ data: { employeeId: orphan, date: new Date(QUIET_DAY), state: "ABSENT" } });
    const shift = await post("desk", "/shifts", { name: `${SHIFT} window`, startTime: "08:00", endTime: "17:00", graceMinutes: 5 });
    assert.equal(shift.status, 201, JSON.stringify(shift.body));
    const id = await file("orphan");
    const before = (await pushesTo("orphan", 0)).length;
    const validFrom = new Date(Date.now() + 5 * DAY_MS).toISOString().slice(0, 10);
    const assigned = await post("desk", `/shifts/${shift.body.id}/assignments`, { employeeId: orphan, validFrom });
    assert.equal(assigned.status, 201, JSON.stringify(assigned.body));
    assert.equal((await post("desk", `/requests/${id}/decide`, { approve: true })).status, 201);
    await app.get(AttendanceSweep).afterBuild(QUIET_DAY, orphan);
    await new Promise((done) => setTimeout(done, 1500));
    const told = (await pushesTo("orphan", before + 2)).slice(before);
    assert.deepEqual(told.map((one) => one.body.kind).sort(), ["REQUEST_DECIDED", "SHIFT_CHANGED"], "the person heard other than the answer and the shift");
    assert.equal(told.find((one) => one.body.kind === "SHIFT_CHANGED")?.body.count, 1, "the window counted rows that never waited in it");
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
    assert.equal(told[0].body.gathered, "work", "days to explain were not told as work");
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
    assert.equal(told[0].body.gathered, "news", "two shift changes were told as work waiting");
  });
});
