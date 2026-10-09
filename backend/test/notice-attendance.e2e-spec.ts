import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { Test } from "@nestjs/testing";
import type { Role } from "@prisma/client";
import { io, type Socket } from "socket.io-client";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import type { Viewer } from "../src/common/scope/viewer.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { hashPassword } from "../src/modules/auth/password.js";
import { KIOSK_EVENT } from "../src/modules/mqtt/mqtt.events.js";
import { itemKey } from "../src/modules/notifications/notice-items.service.js";
import { NotificationsService } from "../src/modules/notifications/notifications.service.js";
import { AttendanceSweep } from "../src/modules/notifications/sweeps/attendance.sweep.js";
import { KioskSweep } from "../src/modules/notifications/sweeps/kiosk.sweep.js";
import { PayrollService } from "../src/modules/payroll/payroll.service.js";
import { FEED } from "../src/modules/realtime/realtime.gateway.js";
import { dayWindow, localDay } from "../src/modules/timesheet/local-day.js";
import { TimesheetService } from "../src/modules/timesheet/timesheet.service.js";

const RUN = randomUUID().slice(0, 6);
const PASSWORD = "e2e-notice-attendance-password";
const WORKERS = ["late", "lone", "absent", "clean", "fixed", "leave"] as const;
const PEOPLE = [...WORKERS, "boss", "hr", "pay"] as const;
type Who = (typeof PEOPLE)[number];
const ROLE: Record<Who, Role> = {
  late: "EMPLOYEE",
  lone: "EMPLOYEE",
  absent: "EMPLOYEE",
  clean: "EMPLOYEE",
  fixed: "EMPLOYEE",
  leave: "EMPLOYEE",
  boss: "MANAGER",
  hr: "HR",
  pay: "PAYROLL",
};
const codeOf = (who: Who) => `E2ENA${PEOPLE.indexOf(who)}${RUN}`;
const mailOf = (who: Who) => `e2e-notice-attendance-${who}-${RUN}@kiosk.local`;
const ENTITY_CODE = `E2E-NA-${RUN}`;
const DEPARTMENT_CODE = `E2E-NA-D-${RUN}`;
const SHIFTS = [`E2E NA ${RUN}`, `E2E NA late ${RUN}`];
const DEVICE = `e2e-na-${RUN}`;
// A Tuesday and a Wednesday no other suite builds, pays or keeps a holiday on.
const DAY = "2026-07-14";
const NEXT = "2026-07-15";
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const SETTLE_MS = 400;

type Message = Record<string, unknown>;

describe("the attendance family, each told to its own people and closed when the day settles (e2e)", () => {
  let app: INestApplication;
  let db: PrismaService;
  let zone = "";
  let port = 0;
  let entityId = "";
  let shiftId = "";
  let lateShiftId = "";
  let local = 0;
  const loginOf = new Map<Who, string>();
  const idOf = new Map<Who, number>();
  const tokenOf = new Map<Who, string>();
  const sockets: Socket[] = [];

  const id = (who: Who) => idOf.get(who) ?? 0;
  const viewerOf = (who: Who): Viewer => ({ userId: loginOf.get(who) ?? "", role: ROLE[who], employeeId: id(who) });
  const send = (who: Who, method: "post" | "patch" | "get", path: string, body: object = {}) =>
    request(app.getHttpServer())[method](path).set("Authorization", `Bearer ${tokenOf.get(who)}`).send(body);
  const at = (day: string, clock: string) => {
    const [hour, minute] = clock.split(":").map(Number);
    return new Date(dayWindow(day, zone).from.getTime() + (hour * 60 + minute) * MINUTE_MS);
  };
  const workKey = (who: Who, day: string) => itemKey("ATTENDANCE", `${id(who)}:${day}`);
  const workOf = (who: Who, day: string) => db.noticeItem.findUnique({ where: { key: workKey(who, day) } });
  const facts = (row: { facts: unknown } | null) => (row?.facts ?? {}) as Record<string, unknown>;

  async function punch(who: Who, day: string, clock: string): Promise<void> {
    local += 1;
    const ts = at(day, clock);
    await db.attendanceRecord.create({
      data: { deviceId: DEVICE, localId: String(local), employeeId: id(who), ts, receivedAt: ts, direction: "IN" },
    });
  }

  // A device's punches and events go with it, and the work with the people it is about.
  async function sweep(): Promise<void> {
    const logins = await db.user.findMany({ where: { email: { in: PEOPLE.map(mailOf) } }, select: { id: true } });
    await db.noticeItem.deleteMany({ where: { queue: "TEAM_ATTENDANCE", subjectId: { in: logins.map((one) => one.id) } } });
    await db.noticeItem.deleteMany({ where: { queue: "KIOSK", subjectId: DEVICE } });
    await db.device.deleteMany({ where: { id: DEVICE } });
    await db.payrollPeriod.deleteMany({ where: { legalEntity: { code: ENTITY_CODE } } });
    await db.user.deleteMany({ where: { email: { in: PEOPLE.map(mailOf) } } });
    await db.employee.deleteMany({ where: { code: { in: PEOPLE.map(codeOf) } } });
    await db.shift.deleteMany({ where: { name: { in: SHIFTS } } });
    await db.department.deleteMany({ where: { code: DEPARTMENT_CODE } });
    await db.legalEntity.deleteMany({ where: { code: ENTITY_CODE } });
  }

  async function watch(who: Who): Promise<Message[]> {
    const heard: Message[] = [];
    const socket = io(`http://127.0.0.1:${port}/feed`, { transports: ["websocket"], reconnection: false, auth: { token: tokenOf.get(who) } });
    socket.on(FEED.notice, (body: Message) => heard.push(body));
    sockets.push(socket);
    await new Promise<void>((done) => socket.on("connect", () => done()));
    await new Promise((done) => setTimeout(done, SETTLE_MS));
    return heard;
  }

  before(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    await app.listen(0);
    port = (app.getHttpServer().address() as { port: number }).port;
    db = app.get(PrismaService);
    zone = app.get(ConfigService).get("APP_TIMEZONE") as string;
    await sweep();
    entityId = (await db.legalEntity.create({ data: { code: ENTITY_CODE, name: `Pháp nhân chấm công ${RUN}` } })).id;
    const departmentId = (await db.department.create({ data: { legalEntityId: entityId, code: DEPARTMENT_CODE, name: `Phòng chấm công ${RUN}` } })).id;
    // The manager first, so everybody in the tree names them as they are made.
    for (const who of ["boss", "hr", "pay", ...WORKERS] as Who[]) {
      const made = await db.employee.create({
        data: {
          code: codeOf(who),
          fullName: `Công ${who} ${RUN}`,
          active: true,
          legalEntityId: entityId,
          departmentId,
          managerId: (WORKERS as readonly Who[]).includes(who) ? id("boss") : null,
        },
      });
      idOf.set(who, made.id);
      const login = await db.user.create({
        data: { email: mailOf(who), role: ROLE[who], employeeId: made.id, passwordHash: await hashPassword(PASSWORD) },
      });
      loginOf.set(who, login.id);
      const res = await request(app.getHttpServer()).post("/auth/login").send({ email: mailOf(who), password: PASSWORD });
      tokenOf.set(who, res.body.accessToken as string);
    }
    shiftId = (await db.shift.create({ data: { name: SHIFTS[0], startTime: "08:00", endTime: "17:00", graceMinutes: 5 } })).id;
    lateShiftId = (await db.shift.create({ data: { name: SHIFTS[1], startTime: "09:00", endTime: "18:00", graceMinutes: 5 } })).id;
    await db.shiftAssignment.createMany({
      data: WORKERS.map((who) => ({ shiftId, employeeId: id(who), validFrom: new Date("2026-01-01") })),
    });
    await db.shiftAssignment.create({
      data: { shiftId: lateShiftId, employeeId: id("fixed"), validFrom: new Date(NEXT), validTo: new Date(NEXT) },
    });
    await db.request.create({
      data: { employeeId: id("leave"), kind: "LEAVE", state: "APPROVED", fromDate: new Date(DAY), toDate: new Date(NEXT), days: 2, reason: "e2e" },
    });
    await db.device.create({ data: { id: DEVICE, status: "APPROVED", name: `Cổng chấm công ${RUN}` } });
    await punch("late", DAY, "08:20");
    await punch("late", DAY, "17:05");
    await punch("lone", DAY, "08:02");
    await punch("clean", DAY, "07:58");
    await punch("clean", DAY, "17:02");
    await punch("late", NEXT, "08:20");
    await punch("late", NEXT, "17:05");
    await punch("lone", NEXT, "08:02");
    await punch("clean", NEXT, "07:58");
  });

  // A cleanup that throws must still close the app, or its workers keep the process alive.
  after(async () => {
    sockets.forEach((one) => one.close());
    try {
      await sweep();
    } finally {
      await app.close();
    }
  });

  it("opens one exception for each person-day off its shift, unread and unpushed, and none for a clean or covered day", async () => {
    const timesheet = app.get(TimesheetService);
    for (const who of WORKERS) {
      await timesheet.build(DAY, id(who));
    }
    const opened = await db.noticeItem.findMany({ where: { queue: "ATTENDANCE", employeeId: { in: WORKERS.map(id) } } });
    assert.deepEqual(
      opened.map((one) => one.key).sort(),
      (["late", "lone", "absent", "fixed"] as Who[]).map((who) => workKey(who, DAY)).sort(),
      "a day opened work it should not have, or a deviating day opened none",
    );
    assert.deepEqual(facts(await workOf("late", DAY)), { day: DAY, lateMinutes: 15 });
    assert.deepEqual(facts(await workOf("lone", DAY)), { day: DAY, missing: "OUT" }, "a lone morning punch was not read as the way in");
    assert.deepEqual(facts(await workOf("absent", DAY)), { day: DAY, absent: true });
    for (const item of opened) {
      assert.deepEqual([item.state, item.subjectType, item.lastMark], ["OPEN", "PERSON_DAY", null]);
      const rows = await db.notification.findMany({ where: { itemId: item.id } });
      assert.equal(rows.length, 1, "the work reached somebody besides its own person");
      assert.equal(rows[0]?.userId, [...loginOf.entries()].find(([who]) => id(who) === item.employeeId)?.[1]);
      assert.equal(rows[0]?.readAt, null, "the work arrived already read");
    }
  });

  it("opens nothing more on a second build, and clears a day a late punch settles", async () => {
    const timesheet = app.get(TimesheetService);
    const first = await db.noticeItem.findMany({ where: { queue: "ATTENDANCE", employeeId: { in: WORKERS.map(id) } }, select: { id: true } });
    for (const who of WORKERS) {
      await timesheet.build(DAY, id(who));
    }
    const again = await db.noticeItem.findMany({ where: { queue: "ATTENDANCE", employeeId: { in: WORKERS.map(id) } }, select: { id: true } });
    assert.deepEqual(again.map((one) => one.id).sort(), first.map((one) => one.id).sort(), "a second build opened more work");
    assert.equal(await db.notification.count({ where: { kind: "ATTENDANCE_EXCEPTION", userId: { in: [...loginOf.values()] } } }), first.length);

    await punch("lone", DAY, "17:01");
    await timesheet.build(DAY, id("lone"));
    const settled = await workOf("lone", DAY);
    assert.equal(settled?.state, "CLEARED", "a day the late punch set right stayed open");
    assert.equal(await db.notification.count({ where: { itemId: settled?.id, readAt: null } }), 0);
  });

  it("claims the morning push of missing punches and absences once, and never of lateness", async () => {
    const sweep = app.get(AttendanceSweep);
    await sweep.sweep();
    assert.equal((await workOf("absent", DAY))?.lastMark, 1, "an absence was not pushed");
    assert.equal((await workOf("fixed", DAY))?.lastMark, 1);
    assert.equal((await workOf("late", DAY))?.lastMark, null, "lateness pushed");
    await sweep.sweep();
    assert.equal((await workOf("absent", DAY))?.lastMark, 1, "a second sweep claimed the push again");
  });

  it("clears a day HR corrects and tells its person who did, and clears one their approved request covers without that", async () => {
    const day = await db.attendanceDay.findFirstOrThrow({ where: { employeeId: id("absent"), date: new Date(DAY) } });
    const corrected = await send("hr", "patch", `/timesheet/${day.id}`, { workedMinutes: 480, reason: "e2e" });
    assert.equal(corrected.status, 200, JSON.stringify(corrected.body));
    assert.equal((await workOf("absent", DAY))?.state, "CLEARED", "a corrected day stayed open");
    const told = await db.notification.findFirst({ where: { userId: loginOf.get("absent"), kind: "DAY_CORRECTED" } });
    assert.ok(told, "the person was not told their day was corrected");
    assert.deepEqual([told.subjectType, told.subjectId], ["PERSON_DAY", `${id("absent")}:${DAY}`]);
    assert.equal(facts(told).day, DAY);
    assert.equal(typeof facts(told).correctedAt, "number");
    const seen = await send("absent", "get", `/timesheet?from=${DAY}&to=${DAY}&employeeId=${id("absent")}`);
    assert.equal(seen.status, 200, JSON.stringify(seen.body));
    assert.equal(seen.body[0]?.adjustedByName, `Công hr ${RUN}`, "the person cannot read who corrected their day");

    const fix = await db.request.create({
      data: {
        employeeId: id("fixed"),
        kind: "ATTENDANCE_FIX",
        state: "PENDING",
        fromDate: new Date(DAY),
        toDate: new Date(DAY),
        minutes: 480,
        reason: "e2e",
        approverId: id("boss"),
      },
    });
    const decided = await send("boss", "post", `/requests/${fix.id}/decide`, { approve: true });
    assert.equal(decided.status, 201, JSON.stringify(decided.body));
    assert.equal((await workOf("fixed", DAY))?.state, "CLEARED", "a day an approved fix covers stayed open");
    assert.equal(
      await db.notification.count({ where: { userId: loginOf.get("fixed"), kind: "DAY_CORRECTED" } }),
      0,
      "the person was told twice of a fix they asked for",
    );
  });

  it("lets the person close their own day as needing no explanation, and nobody else", async () => {
    const key = workKey("late", DAY);
    for (const who of ["boss", "hr"] as Who[]) {
      const refused = await send(who, "post", `/notifications/items/${key}/resolve`, { note: "" });
      assert.equal(refused.status, 404, `${who} closed somebody else's day: ${JSON.stringify(refused.body)}`);
    }
    const shown = await send("late", "get", `/notifications/items/${key}`);
    assert.equal(shown.status, 200, JSON.stringify(shown.body));
    assert.equal(shown.body.resolvable, true);
    assert.deepEqual(shown.body.facts, { day: DAY, lateMinutes: 15 }, "the day cannot say what is off on it");
    const closed = await send("late", "post", `/notifications/items/${key}/resolve`, { note: "" });
    assert.equal(closed.status, 201, JSON.stringify(closed.body));
    const item = await workOf("late", DAY);
    assert.deepEqual([item?.state, item?.outcome, item?.actorId], ["DONE", "RESOLVED", loginOf.get("late")]);
    const twice = await send("late", "post", `/notifications/items/${key}/resolve`, { note: "" });
    assert.equal(twice.status, 409, JSON.stringify(twice.body));
  });

  it("sums up the morning for the manager over their tree and for the desk over the company, once a day", async () => {
    const sweep = app.get(AttendanceSweep);
    const now = at(NEXT, "08:45");
    assert.equal(await sweep.summariseFor(viewerOf("boss"), at(NEXT, "08:20")), false, "a summary opened before the first shift was half an hour in");
    assert.equal(await sweep.summariseFor(viewerOf("boss"), now), true);
    const mine = await db.noticeItem.findUniqueOrThrow({ where: { key: itemKey("TEAM_ATTENDANCE", { id: loginOf.get("boss") ?? "", part: NEXT }) } });
    assert.deepEqual(facts(mine), { day: NEXT, late: 1, notPunched: 1, absent: 1, onLeave: 1 }, "the manager's tree was counted wrong");
    assert.deepEqual([mine.subjectType, mine.subjectId], ["LOGIN", loginOf.get("boss")]);
    const rows = await db.notification.findMany({ where: { itemId: mine.id } });
    assert.deepEqual(rows.map((one) => [one.userId, one.readAt]), [[loginOf.get("boss"), null]], "the summary reached somebody else");
    assert.equal(await sweep.summariseFor(viewerOf("boss"), at(NEXT, "09:30")), false, "a second summary opened the same day");

    assert.equal(await sweep.summariseFor(viewerOf("hr"), now), true);
    const desk = await db.noticeItem.findUniqueOrThrow({ where: { key: itemKey("TEAM_ATTENDANCE", { id: loginOf.get("hr") ?? "", part: NEXT }) } });
    for (const count of ["late", "notPunched", "absent", "onLeave"]) {
      assert.ok(Number(facts(desk)[count]) >= 1, `the desk's company left out the tree's ${count}`);
    }
    await sweep.closeSummaries(new Date(now.getTime() + DAY_MS));
    assert.equal((await db.noticeItem.findUniqueOrThrow({ where: { id: mine.id } })).state, "EXPIRED", "a summary outlived its day");
  });

  it("expires what is still open once the period is locked, opens nothing in it after, and tells everyone paid the month closed", async () => {
    const timesheet = app.get(TimesheetService);
    await timesheet.build(NEXT, id("absent"));
    assert.equal((await workOf("absent", NEXT))?.state, "OPEN");
    const period = await db.payrollPeriod.create({
      data: { legalEntityId: entityId, year: 2026, month: 7, startDate: new Date("2026-07-01"), endDate: new Date("2026-07-31") },
    });
    const run = await db.payrollRun.create({ data: { periodId: period.id, state: "DONE", finishedAt: new Date() } });
    const policy = await db.payrollPolicy.findFirstOrThrow({ orderBy: { effectiveFrom: "asc" } });
    await db.payslip.createMany({
      data: (["late", "clean"] as Who[]).map((who) => ({ runId: run.id, periodId: period.id, employeeId: id(who), policyId: policy.id })),
    });
    await app.get(PayrollService).lock(viewerOf("pay"), period.id, { acceptOpenItems: true });
    assert.equal((await workOf("absent", NEXT))?.state, "EXPIRED", "work of a paid day stayed open");
    await timesheet.build(NEXT, id("lone"));
    assert.equal(await workOf("lone", NEXT), null, "a day of a locked period opened work");
    for (const who of ["late", "clean"] as Who[]) {
      const told = await db.notification.findFirst({ where: { userId: loginOf.get(who), kind: "TIMESHEET_MONTH_CLOSED" } });
      assert.ok(told, `${who} was not told the month closed`);
      assert.deepEqual([told.subjectType, told.subjectId, facts(told).month], ["PAYROLL_PERIOD", period.id, "2026-07"]);
    }
    assert.equal(await db.notification.count({ where: { userId: loginOf.get("absent"), kind: "TIMESHEET_MONTH_CLOSED" } }), 0);
  });

  it("tells a person of a shift change from today on, and nobody of one only to days gone", async () => {
    const today = localDay(new Date(), zone);
    const dayAfter = (offset: number) => new Date(new Date(`${today}T00:00:00.000Z`).getTime() + offset * DAY_MS).toISOString().slice(0, 10);
    const toldOf = (who: Who) => db.notification.findMany({ where: { userId: loginOf.get(who), kind: "SHIFT_CHANGED" } });
    const gone = await send("hr", "post", `/shifts/${lateShiftId}/assignments`, { employeeId: id("clean"), validFrom: "2026-03-02", validTo: "2026-03-03" });
    assert.equal(gone.status, 201, JSON.stringify(gone.body));
    assert.equal((await toldOf("clean")).length, 0, "a change only to days gone told somebody");
    const ahead = await send("hr", "post", `/shifts/${lateShiftId}/assignments`, { employeeId: id("clean"), validFrom: dayAfter(-1) });
    assert.equal(ahead.status, 201, JSON.stringify(ahead.body));
    assert.deepEqual((await toldOf("clean")).map((one) => facts(one).day), [today], "a change running into today did not say from today");
    const bulk = await send("hr", "post", `/shifts/${lateShiftId}/assignments/bulk?apply=true`, {
      employeeIds: [id("late"), id("lone")],
      validFrom: dayAfter(1),
    });
    assert.equal(bulk.status, 201, JSON.stringify(bulk.body));
    for (const who of ["late", "lone"] as Who[]) {
      assert.deepEqual((await toldOf(who)).map((one) => facts(one).day), [dayAfter(1)], `${who} was not told of a bulk change`);
    }
  });

  it("never writes a row for a punch, and tells the person's open screens only while they want it", async () => {
    const heard = await watch("clean");
    await db.deviceEnrollment.create({ data: { deviceId: DEVICE, employeeId: id("clean"), state: "ENROLLED" } });
    const bus = app.get(EventEmitter2);
    const arrive = async () => {
      local += 1;
      const ts = Date.now();
      await bus.emitAsync(KIOSK_EVENT.attendance, {
        topic: "attendance",
        deviceId: DEVICE,
        receivedAt: new Date(),
        payload: { deviceId: DEVICE, localId: String(local), employeeId: id("clean"), ts, direction: "IN", matchScore: 0.9, livenessScore: 0.9, modelVersion: 1 },
      });
      await new Promise((done) => setTimeout(done, SETTLE_MS));
      return ts;
    };
    const ts = await arrive();
    assert.deepEqual(
      heard.filter((one) => one.op === "punch"),
      [{ op: "punch", ts: new Date(ts).toISOString(), deviceId: DEVICE, delayed: false }],
      "the person's open screen did not hear their punch",
    );
    await app.get(NotificationsService).raise(loginOf.get("clean") ?? "", "PUNCH_RECORDED", {});
    assert.equal(await db.notification.count({ where: { kind: "PUNCH_RECORDED" } }), 0, "a punch wrote a row");

    const off = await send("clean", "post", "/notifications/preferences", { kind: "PUNCH_RECORDED", channel: "IN_APP", on: false });
    assert.equal(off.status, 201, JSON.stringify(off.body));
    await arrive();
    assert.equal(heard.filter((one) => one.op === "punch").length, 1, "a punch was told to a screen that turned it off");
  });

  it("opens a spoof burst once at the threshold, and clears it after a quiet hour", async () => {
    const bus = app.get(EventEmitter2);
    const key = itemKey("KIOSK", { id: DEVICE, part: "spoof" });
    const start = Date.now();
    const spoof = (at: number) =>
      bus.emitAsync(KIOSK_EVENT.event, {
        topic: "event",
        deviceId: DEVICE,
        receivedAt: new Date(),
        payload: { deviceId: DEVICE, ts: start + at * 1000, type: "SPOOF_DETECTED", severity: "WARN" },
      });
    for (let at = 0; at < 4; at += 1) {
      await spoof(at);
    }
    assert.equal(await db.noticeItem.findUnique({ where: { key } }), null, "a burst opened short of the threshold");
    await spoof(4);
    const burst = await db.noticeItem.findUnique({ where: { key } });
    assert.ok(burst && burst.state === "OPEN" && burst.level === "WARNING", "the fifth spoof opened no burst");
    assert.equal(facts(burst).code, "SPOOF_BURST");
    await spoof(5);
    assert.equal(await db.noticeItem.count({ where: { key: { startsWith: key } } }), 1, "a burst opened twice");
    await app.get(KioskSweep).closeVanished(DEVICE, new Date(start + 30 * MINUTE_MS));
    assert.equal((await db.noticeItem.findUniqueOrThrow({ where: { key } })).state, "OPEN", "a burst cleared before a quiet hour");
    await app.get(KioskSweep).closeVanished(DEVICE, new Date(start + 61 * MINUTE_MS + 6000));
    assert.equal((await db.noticeItem.findUniqueOrThrow({ where: { key } })).state, "CLEARED", "a burst stayed open after a quiet hour");
  });
});
