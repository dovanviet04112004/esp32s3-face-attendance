import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { EventEmitter2 } from "@nestjs/event-emitter";
import { Test } from "@nestjs/testing";
import type { Notification, Prisma, Release, Role } from "@prisma/client";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { hashPassword } from "../src/modules/auth/password.js";
import { UPDATE_FINISHED } from "../src/modules/models/release-rules.js";
import { KIOSK_EVENT, type KioskMessage } from "../src/modules/mqtt/mqtt.events.js";
import { MailerService } from "../src/modules/notifications/mailer.service.js";
import { itemKey, NoticeItemsService } from "../src/modules/notifications/notice-items.service.js";
import { KioskSweep } from "../src/modules/notifications/sweeps/kiosk.sweep.js";
import { ReleaseSweep } from "../src/modules/notifications/sweeps/release.sweep.js";
import { DocumentsSweep } from "../src/modules/notifications/sweeps/documents.sweep.js";
import { TasksSweep } from "../src/modules/notifications/sweeps/tasks.sweep.js";
import type { MailBody } from "../src/modules/payroll/mail-text.js";
import { PayrollService } from "../src/modules/payroll/payroll.service.js";
import { localDay } from "../src/modules/timesheet/local-day.js";
import { seedEntityId } from "./fixtures.js";

const RUN = randomUUID().slice(0, 6);
const PASSWORD = "e2e-notice-kinds-password";
const PEOPLE = ["pay", "admin", "hire", "boss", "hr"] as const;
type Who = (typeof PEOPLE)[number];
const ROLE: Record<Who, Role> = { pay: "PAYROLL", admin: "ADMIN", hire: "EMPLOYEE", boss: "MANAGER", hr: "HR" };
const codeOf = (who: Who) => `E2ENK${PEOPLE.indexOf(who)}${RUN}`;
const mailOf = (who: Who) => `e2e-notice-kinds-${who}-${RUN}@kiosk.local`;
// An entity of its own holds nobody, so a run here pays no other suite's people.
const ENTITY_CODE = `E2E-NK-${RUN}`;
const DEVICE = `e2e-nk-${RUN}`;
const DEPARTMENT_CODE = `E2E-NK-D-${RUN}`;
const DOCUMENT_CODE = `E2E-NK-DOC-${RUN}`;
const RETURN_CODE = `E2E-NK-RET-${RUN}`;
const CLAIM = "246813";
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
// A kiosk per kind of evidence, so one family's proof never closes another's work.
const FAULTY = {
  boot: `e2e-nkb-${RUN}`,
  face: `e2e-nkc-${RUN}`,
  punch: `e2e-nks-${RUN}`,
  quiet: `e2e-nkq-${RUN}`,
  update: `e2e-nku-${RUN}`,
} as const;
const SILENT = `e2e-nko-${RUN}`;
const KIOSKS = [DEVICE, SILENT, ...Object.values(FAULTY)];

function factsOf(row: Notification | null): Record<string, unknown> {
  return (row?.facts ?? {}) as Record<string, unknown>;
}

interface BellRow {
  id: string;
  item: { key: string } | null;
  subject: { hidden: boolean; person: { code: string } | null } | null;
}

describe("the kinds E27-T10 adds, each told once to the right people (e2e)", () => {
  let app: INestApplication;
  let db: PrismaService;
  const loginOf = new Map<Who, string>();
  const idOf = new Map<Who, number>();
  const tokenOf = new Map<Who, string>();
  let entityId = "";
  let departmentId = "";
  const mailed: { to: string; body: MailBody }[] = [];

  const post = (who: Who, path: string, body: object = {}) =>
    request(app.getHttpServer()).post(path).set("Authorization", `Bearer ${tokenOf.get(who)}`).send(body);

  // What a kiosk says goes through both listeners, so its row is kept and its work opened, as from the broker.
  const said = (deviceId: string, type: string, receivedAt: Date, ts: Date = receivedAt) =>
    app.get(EventEmitter2).emitAsync(KIOSK_EVENT.event, {
      topic: "event",
      deviceId,
      receivedAt,
      payload: { deviceId, ts: ts.getTime(), type, severity: type === "BOOTED" ? "INFO" : "ERROR" },
    });
  const faultOf = (deviceId: string, part: string) =>
    db.noticeItem.findUniqueOrThrow({ where: { key: itemKey("KIOSK", { id: deviceId, part }) } });
  const faulty = (id: string, data: Omit<Prisma.DeviceCreateInput, "id"> = {}) =>
    db.device.create({ data: { id, status: "APPROVED", online: true, ...data } });
  const punched = (deviceId: string, ts: Date, receivedAt: Date) =>
    db.attendanceRecord.create({
      data: { localId: String(receivedAt.getTime()), deviceId, employeeId: idOf.get("hire") as number, ts, direction: "IN", receivedAt },
    });
  // Minutes from a test's start, so a sweep can be run as if the clock had moved on.
  const clock = () => {
    const start = Date.now();
    return (minutes: number) => new Date(start + minutes * MINUTE_MS);
  };

  // People hang off the department and the department off the entity, so they go in that order.
  async function sweep(): Promise<void> {
    await db.noticeItem.deleteMany({ where: { queue: "KIOSK", subjectId: { in: KIOSKS } } });
    await db.device.deleteMany({ where: { id: { in: KIOSKS } } });
    await db.noticeItem.deleteMany({ where: { queue: { in: ["TASKS", "DOCUMENTS"] }, employee: { code: { in: PEOPLE.map(codeOf) } } } });
    await db.checklistRun.deleteMany({ where: { employee: { code: { in: PEOPLE.map(codeOf) } } } });
    await db.checklistTemplate.deleteMany({ where: { department: { code: DEPARTMENT_CODE } } });
    await db.document.deleteMany({ where: { code: { in: [DOCUMENT_CODE, RETURN_CODE] } } });
    await db.user.deleteMany({ where: { email: { in: PEOPLE.map(mailOf) } } });
    await db.employee.deleteMany({ where: { code: { in: PEOPLE.map(codeOf) } } });
    await db.department.deleteMany({ where: { code: DEPARTMENT_CODE } });
    await db.payrollPeriod.deleteMany({ where: { legalEntity: { code: ENTITY_CODE } } });
    await db.legalEntity.deleteMany({ where: { code: ENTITY_CODE } });
  }

  before(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    db = app.get(PrismaService);
    app.get(MailerService).send = async (to: string, body: MailBody) => {
      mailed.push({ to, body });
      return true;
    };
    await sweep();
    const seedEntity = await seedEntityId(db);
    for (const who of PEOPLE) {
      const made = await db.employee.create({
        data: { code: codeOf(who), fullName: `Loại ${who} ${RUN}`, active: true, legalEntityId: seedEntity },
      });
      idOf.set(who, made.id);
      const login = await db.user.create({
        data: { email: mailOf(who), role: ROLE[who], employeeId: made.id, passwordHash: await hashPassword(PASSWORD) },
      });
      loginOf.set(who, login.id);
      const res = await request(app.getHttpServer()).post("/auth/login").send({ email: mailOf(who), password: PASSWORD });
      tokenOf.set(who, res.body.accessToken as string);
    }
    entityId = (await db.legalEntity.create({ data: { code: ENTITY_CODE, name: `Pháp nhân loại tin ${RUN}` } })).id;
    departmentId = (await db.department.create({ data: { legalEntityId: entityId, code: DEPARTMENT_CODE, name: `Phòng loại tin ${RUN}` } })).id;
    await db.employee.update({ where: { id: idOf.get("hire") }, data: { departmentId, managerId: idOf.get("boss") } });
    const base = await db.payrollPolicy.findFirstOrThrow({ include: { brackets: true }, orderBy: { effectiveFrom: "asc" } });
    const { id: _id, legalEntityId: _entity, createdAt: _made, brackets, ...fields } = base;
    await db.payrollPolicy.create({
      data: {
        ...fields,
        legalEntityId: entityId,
        brackets: { create: brackets.map((band) => ({ ordinal: band.ordinal, upToAmount: band.upToAmount, rateBp: band.rateBp })) },
      },
    });
  });

  // A cleanup that throws must still close the app, or its workers keep the process alive.
  after(async () => {
    try {
      await sweep();
    } finally {
      await app.close();
    }
  });

  it("tells whoever pressed a payroll run how it ended, again on a rerun, and nobody of a run made outside the api", async () => {
    const payroll = app.get(PayrollService);
    const period = await db.payrollPeriod.create({
      data: { legalEntityId: entityId, year: 2044, month: 3, startDate: new Date("2044-03-01"), endDate: new Date("2044-03-31") },
    });
    const made = await post("pay", "/payroll-runs", { periodId: period.id, kind: "REGULAR" });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const runId = made.body.id as string;
    const toldOf = () =>
      db.notification.findFirst({ where: { userId: loginOf.get("pay"), kind: "PAYROLL_RUN_DONE", subjectId: runId } });

    assert.equal((await payroll.runNow(runId)).state, "DONE");
    const first = await toldOf();
    assert.ok(first, "whoever pressed run was not told");
    assert.equal(first.subjectType, "PAYROLL_RUN");
    const read = await request(app.getHttpServer()).get(`/notifications/${first.id}`).set("Authorization", `Bearer ${tokenOf.get("pay")}`);
    assert.deepEqual(read.body.subject?.parent, { type: "PAYROLL_PERIOD", id: period.id }, "the notice opens no period");
    assert.equal(factsOf(first).failed, false);
    assert.equal(factsOf(first).payslips, 0);
    await db.notification.update({ where: { id: first.id }, data: { readAt: new Date() } });

    await payroll.runNow(runId);
    const again = await toldOf();
    assert.equal(again?.id, first.id, "a rerun wrote a second row");
    assert.ok(again && again.readAt === null && again.remindCount === 1, "a rerun of the same draft was not said again");

    await db.payrollPeriod.update({ where: { id: period.id }, data: { state: "LOCKED" } });
    assert.equal((await payroll.runNow(runId)).state, "FAILED");
    assert.equal(factsOf(await toldOf()).failed, true, "a run that did not finish read as finished");

    const stray = await db.payrollRun.create({ data: { periodId: period.id, kind: "REGULAR" } });
    await payroll.failRun(stray.id, "INTERNAL_ERROR");
    assert.equal(
      await db.notification.count({ where: { kind: "PAYROLL_RUN_DONE", subjectId: stray.id } }),
      0,
      "a run nobody pressed told somebody",
    );
  });

  it("gives the ADMINs a kiosk's own work: waiting to join, a fault closed by hand and back, a silence said once", async () => {
    const kiosk = app.get(KioskSweep);
    const bus = app.get(EventEmitter2);
    const keyOf = (part: string) => itemKey("KIOSK", { id: DEVICE, part });
    const itemOf = (part: string) => db.noticeItem.findUnique({ where: { key: keyOf(part) } });
    const told = (itemId: string) => db.notification.findFirst({ where: { itemId, userId: loginOf.get("admin") } });
    const report = (type: string) =>
      bus.emitAsync(KIOSK_EVENT.event, {
        topic: "event",
        deviceId: DEVICE,
        receivedAt: new Date(),
        payload: { deviceId: DEVICE, ts: Date.now(), type, severity: "ERROR" },
      });
    const heard = (retained: boolean): KioskMessage<string> => ({ topic: "status", deviceId: DEVICE, receivedAt: new Date(), payload: "online", retained });

    const asked = await request(app.getHttpServer())
      .post("/devices/register")
      .send({ deviceId: DEVICE, bootstrapToken: validateEnv().DEVICE_BOOTSTRAP_TOKEN, claimCode: CLAIM });
    assert.equal(asked.status, 202, JSON.stringify(asked.body));
    const waiting = await itemOf("pending");
    assert.ok(waiting && waiting.state === "OPEN" && waiting.level === "ACTION", "a kiosk asking to join opened no work");
    assert.equal(waiting.subjectType, "DEVICE");
    assert.ok(await told(waiting.id), "the ADMIN was not told of a kiosk waiting");
    assert.equal(
      await db.notification.count({ where: { itemId: waiting.id, user: { role: { not: "ADMIN" } } } }),
      0,
      "somebody besides the ADMINs was told",
    );
    const approved = await post("admin", `/devices/${DEVICE}/approve`, { claimCode: CLAIM, name: "Cổng thử", location: "Tầng 1" });
    assert.equal(approved.status, 201, JSON.stringify(approved.body));
    const joined = await itemOf("pending");
    assert.deepEqual([joined?.state, joined?.outcome, joined?.actorId], ["DONE", "APPROVED", loginOf.get("admin")]);

    await report("CAMERA_FAULT");
    await report("CAMERA_FAULT");
    const camera = await itemOf("camera-fault");
    assert.ok(camera && camera.state === "OPEN" && camera.level === "CRITICAL", "a fault opened no critical work");
    assert.equal(await db.noticeItem.count({ where: { key: { startsWith: keyOf("camera-fault") } } }), 1, "a repeat opened work twice");
    const bell = await request(app.getHttpServer()).get(`/notifications/${(await told(camera.id))?.id}`).set("Authorization", `Bearer ${tokenOf.get("admin")}`);
    assert.deepEqual(bell.body.subject?.device, { name: "Cổng thử" }, "the fault's row does not name its kiosk");
    const resolved = await post("admin", `/notifications/items/${keyOf("camera-fault")}/resolve`, { note: "e2e" });
    assert.equal(resolved.status, 201, JSON.stringify(resolved.body));
    const traced = await db.auditLog.findFirst({ where: { action: "notice.resolve", subjectType: "device", subjectId: DEVICE } });
    assert.equal((traced?.meta as { key?: string } | null)?.key, keyOf("camera-fault"), "a kiosk closed by hand is not traced from the kiosk");
    await report("CAMERA_FAULT");
    const back = await itemOf("camera-fault");
    assert.ok(back && back.state === "OPEN" && back.id !== camera.id, "a fault back after a hand close opened no work");
    const history = await db.noticeItem.findUniqueOrThrow({ where: { id: camera.id } });
    assert.deepEqual([history.state, history.outcome], ["DONE", "RESOLVED"], "the closed fault lost who closed it");

    mailed.length = 0;
    await db.device.update({ where: { id: DEVICE }, data: { online: false, lastSeenAt: new Date(Date.now() - 2 * HOUR_MS) } });
    await kiosk.sweep();
    await kiosk.sweep();
    const silent = await itemOf("offline");
    assert.ok(silent && silent.state === "OPEN" && silent.level === "CRITICAL", "a silent kiosk opened no work");
    assert.equal(
      mailed.filter((one) => one.to === mailOf("admin") && one.body.text.includes(DEVICE)).length,
      1,
      "a silence was mailed other than once",
    );
    await kiosk.onStatus(heard(true));
    assert.equal((await itemOf("offline"))?.state, "OPEN", "the broker's replayed copy cleared a silence");
    await bus.emitAsync(KIOSK_EVENT.status, heard(false));
    assert.equal((await itemOf("offline"))?.state, "CLEARED", "a kiosk heard again stayed silent");

    await db.noticeItem.update({ where: { id: silent.id }, data: { openedAt: new Date(Date.now() - 3 * HOUR_MS) } });
    await db.device.update({ where: { id: DEVICE }, data: { online: false, lastSeenAt: new Date(Date.now() - 2 * HOUR_MS) } });
    await kiosk.sweep();
    const next = await itemOf("offline");
    assert.ok(next && next.state === "OPEN" && next.id !== silent.id, "the next silence opened no work of its own");
    const quiet = await post("admin", `/notifications/items/${keyOf("offline")}/resolve`, { note: "e2e" });
    assert.equal(quiet.status, 201, JSON.stringify(quiet.body));
    await kiosk.sweep();
    assert.equal((await itemOf("offline"))?.state, "DONE", "a silence closed by hand opened again before the kiosk spoke");

    const revoked = await post("admin", `/devices/${DEVICE}/revoke`);
    assert.equal(revoked.status, 201, JSON.stringify(revoked.body));
    assert.equal(
      await db.noticeItem.count({ where: { queue: "KIOSK", subjectId: DEVICE, state: "OPEN" } }),
      0,
      "a revoked kiosk kept open work",
    );
  });

  it("mails a silence again while every ADMIN address refuses it, and never again once one took it", async () => {
    const kiosk = app.get(KioskSweep);
    const mailer = app.get(MailerService);
    await db.device.create({ data: { id: SILENT, status: "APPROVED", online: false, lastSeenAt: new Date(Date.now() - 2 * HOUR_MS) } });
    const letters = () => mailed.filter((one) => one.to === mailOf("admin") && one.body.text.includes(SILENT)).length;
    const held = mailer.send;
    mailer.send = async () => {
      throw new Error("421 service not available");
    };
    try {
      await kiosk.sweep();
    } finally {
      mailer.send = held;
    }
    const silence = await faultOf(SILENT, "offline");
    assert.ok(silence.state === "OPEN" && silence.lastMark === null, "a silence no address took was counted as mailed");
    await kiosk.sweep();
    assert.equal(letters(), 1, "the letter every address refused was not sent again");
    assert.equal((await faultOf(SILENT, "offline")).lastMark, 1, "the letter that went out was not recorded on the work");
    await kiosk.sweep();
    assert.equal(letters(), 1, "a silence was mailed again once an address took the letter");
  });

  it("clears a boot-time fault once a later boot stands the settle time without it, and only then", async () => {
    const kiosk = app.get(KioskSweep);
    const id = FAULTY.boot;
    const at = clock();
    const state = async () => (await faultOf(id, "model-load-failed")).state;
    await faulty(id);
    await said(id, "BOOTED", at(-2));
    await said(id, "MODEL_LOAD_FAILED", at(-2));
    await kiosk.closeVanished(id, at(30));
    assert.equal(await state(), "OPEN", "the boot that reported the fault cleared it");
    await said(id, "BOOTED", at(1));
    await said(id, "MODEL_LOAD_FAILED", at(2));
    await kiosk.closeVanished(id, at(30));
    assert.equal(await state(), "OPEN", "a boot that reported the fault again cleared it");
    await said(id, "BOOTED", at(3));
    await kiosk.closeVanished(id, at(12));
    assert.equal(await state(), "OPEN", "a boot younger than the settle time cleared the fault");
    await kiosk.closeVanished(id, at(14));
    assert.equal(await state(), "CLEARED", "a settled boot without the fault left it open");
  });

  it("clears a camera fault on a face seen after it, never on a punch taken ahead of it, and reopens when it returns", async () => {
    const kiosk = app.get(KioskSweep);
    const id = FAULTY.face;
    const at = clock();
    await faulty(id);
    await said(id, "CAMERA_FAULT", at(-1));
    const first = await faultOf(id, "camera-fault");
    assert.equal(first.state, "OPEN");
    await punched(id, at(-5), at(1));
    await kiosk.closeVanished(id);
    assert.equal((await faultOf(id, "camera-fault")).state, "OPEN", "a punch taken ahead of the fault and sent after it cleared it");
    await said(id, "QUALITY_REJECTED", at(1));
    await kiosk.closeVanished(id);
    assert.equal((await db.noticeItem.findUniqueOrThrow({ where: { id: first.id } })).state, "CLEARED", "a face seen after the fault left it open");

    await said(id, "CAMERA_FAULT", at(2));
    const back = await faultOf(id, "camera-fault");
    assert.ok(back.state === "OPEN" && back.id !== first.id, "a fault back after it cleared opened no work under its key");
    const told = await db.notification.findFirst({ where: { itemId: back.id, userId: loginOf.get("admin") } });
    assert.ok(told && told.readAt === null, "the ADMIN was not told the fault came back");
    await punched(id, at(3), at(3));
    await kiosk.closeVanished(id);
    assert.equal((await faultOf(id, "camera-fault")).state, "CLEARED", "a punch taken after the fault left it open");
  });

  it("clears a storage fault once a punch gets through after it, whenever the punch was taken", async () => {
    const kiosk = app.get(KioskSweep);
    const id = FAULTY.punch;
    const at = clock();
    await faulty(id);
    await said(id, "STORAGE_FAULT", at(-1));
    await kiosk.closeVanished(id, at(90));
    assert.equal((await faultOf(id, "storage-fault")).state, "OPEN", "a storage fault cleared with no punch through");
    await punched(id, at(-30), at(1));
    await kiosk.closeVanished(id);
    assert.equal((await faultOf(id, "storage-fault")).state, "CLEARED", "a punch through after the fault left it open");
  });

  it("clears a ToF fault after an online hour without it, never while offline, freshly booted, or still reporting", async () => {
    const kiosk = app.get(KioskSweep);
    const id = FAULTY.quiet;
    const at = clock();
    const state = async () => (await faultOf(id, "tof-fault")).state;
    await faulty(id, { bootedAt: at(-120) });
    await said(id, "TOF_FAULT", at(-1));
    await kiosk.closeVanished(id, at(30));
    assert.equal(await state(), "OPEN", "the fault cleared inside its quiet hour");
    await db.device.update({ where: { id }, data: { online: false } });
    await kiosk.closeVanished(id, at(70));
    assert.equal(await state(), "OPEN", "an offline kiosk cleared its fault");
    await db.device.update({ where: { id }, data: { online: true, bootedAt: at(30) } });
    await kiosk.closeVanished(id, at(70));
    assert.equal(await state(), "OPEN", "a kiosk booted inside the hour cleared its fault");
    await db.device.update({ where: { id }, data: { bootedAt: at(-120) } });
    await said(id, "TOF_FAULT", at(40));
    await kiosk.closeVanished(id, at(70));
    assert.equal(await state(), "OPEN", "a fault said again inside the hour cleared");
    await kiosk.closeVanished(id, at(101));
    assert.equal(await state(), "CLEARED", "an online hour without the fault left it open");
  });

  it("clears a failed update once the kiosk runs the newest of every kind, or a later update finishes", async () => {
    const kiosk = app.get(KioskSweep);
    const releases = app.get(ReleaseSweep);
    const id = FAULTY.update;
    const at = clock();
    const newest = (firmware: string, models: string) =>
      new Map([
        ["FIRMWARE", { target: "FIRMWARE", version: firmware } as Release],
        ["MODELS", { target: "MODELS", version: models } as Release],
      ]);
    await faulty(id, { fwVersion: "1.0.0", modelVersion: `recog-e2e-${RUN}` });
    await said(id, "OTA_FAILED", at(-1));
    const failed = await faultOf(id, "update");
    assert.deepEqual([failed.state, failed.level], ["OPEN", "WARNING"]);
    const held = releases.newest;
    try {
      releases.newest = async () => newest("1.1.0", `recog-e2e-${RUN}`);
      await kiosk.closeVanished(id);
      assert.equal((await faultOf(id, "update")).state, "OPEN", "a kiosk still behind cleared its failed update");
      releases.newest = async () => newest("1.0.0", `recog-e2e-${RUN}`);
      await kiosk.closeVanished(id);
      assert.equal((await db.noticeItem.findUniqueOrThrow({ where: { id: failed.id } })).state, "CLEARED", "a kiosk on the newest kept its failed update");
    } finally {
      releases.newest = held;
    }

    await said(id, "OTA_ROLLED_BACK", at(1));
    const again = await faultOf(id, "update");
    assert.ok(again.state === "OPEN" && again.id !== failed.id, "a second failed update opened no work under its key");
    await app.get(EventEmitter2).emitAsync(UPDATE_FINISHED, {
      deviceId: id,
      actorId: loginOf.get("admin"),
      firmware: "1.1.0",
      models: `recog-e2e-${RUN}`,
    });
    assert.equal((await faultOf(id, "update")).state, "CLEARED", "a finished update left the failed one open");
  });

  it("gives each onboarding task to its owner, reminds on the due day and the day after, and closes it as completed", async () => {
    const items = app.get(NoticeItemsService);
    const tasks = app.get(TasksSweep);
    await db.checklistTemplate.create({
      data: {
        kind: "ONBOARDING",
        name: `Nhận việc ${RUN}`,
        departmentId,
        items: {
          create: [
            { ordinal: 1, title: "Đọc sổ tay", owner: "SELF", dueDays: 0 },
            { ordinal: 2, title: "Giới thiệu nhóm", owner: "MANAGER", dueDays: 0 },
            { ordinal: 3, title: "Cấp thẻ", owner: "HR", dueDays: 1 },
          ],
        },
      },
    });
    const now = new Date();
    const today = localDay(now, validateEnv().APP_TIMEZONE);
    const started = await post("hr", "/checklists", { employeeId: idOf.get("hire"), kind: "ONBOARDING", anchorDate: today });
    assert.equal(started.status, 201, JSON.stringify(started.body));
    const [self, manager, desk] = (started.body.tasks as { id: string }[]).map((one) => one.id);
    const itemOf = (taskId: string) => db.noticeItem.findUniqueOrThrow({ where: { key: itemKey("TASKS", taskId) } });
    const holders = async (taskId: string) =>
      (await db.notification.findMany({ where: { item: { key: itemKey("TASKS", taskId) }, leftAt: null }, select: { userId: true } })).map((one) => one.userId);

    assert.deepEqual(await holders(self), [loginOf.get("hire")], "the person's own task reached somebody else");
    assert.deepEqual(await holders(manager), [loginOf.get("boss")], "the manager's task reached somebody else");
    const deskHolders = await holders(desk);
    assert.ok(deskHolders.includes(loginOf.get("hr") as string), "the desk's task missed HR");
    assert.ok(!deskHolders.includes(loginOf.get("hire") as string), "the person was handed the desk's task about them");
    assert.equal((await itemOf(self)).subjectType, "TASK");
    const bossBell = (query: string) =>
      request(app.getHttpServer()).get(`/notifications${query}`).set("Authorization", `Bearer ${tokenOf.get("boss")}`);
    const ownedRow = async (query: string) =>
      ((await bossBell(query)).body.rows as BellRow[]).find((row) => row.item?.key === itemKey("TASKS", manager));
    const owned = await ownedRow("");
    assert.equal(owned?.subject?.hidden, false, "a manager cannot read whom the task they own is about");
    assert.equal(owned?.subject?.person?.code, codeOf("hire"));
    assert.ok(await ownedRow(`?search=${codeOf("hire")}`), "a manager's search missed the task they own");

    await tasks.sweep(now);
    await tasks.sweep(now);
    const due = await db.notification.findFirstOrThrow({ where: { item: { key: itemKey("TASKS", self) } } });
    assert.equal(due.remindCount, 1, "the due day was said other than once");
    assert.deepEqual(due.facts, { owner: "SELF", daysLeft: 0 }, "a reminder dropped what the row already said");
    assert.equal((await itemOf(desk)).lastMark, null, "a task due tomorrow spoke today");

    await tasks.sweep(new Date(now.getTime() + 2 * DAY_MS));
    const late = await itemOf(desk);
    assert.equal(late.lastMark, 2, "a missed due day was not said at the highest mark passed");
    assert.equal(late.level, "WARNING", "an overdue task did not turn to a warning");

    const finished = await post("hire", `/checklist-tasks/${self}/finish`, {});
    assert.equal(finished.status, 201, JSON.stringify(finished.body));
    const done = await itemOf(self);
    assert.deepEqual([done.state, done.outcome, done.actorId], ["DONE", "COMPLETED", loginOf.get("hire")]);

    await db.user.update({ where: { id: loginOf.get("boss") }, data: { active: false } });
    await items.regroup(await itemOf(manager), "quiet");
    const moved = await holders(manager);
    assert.ok(!moved.includes(loginOf.get("boss") as string), "a closed login kept the manager's task");
    assert.ok(moved.includes(loginOf.get("hr") as string), "a task whose manager has no login did not reach the desk");
  });

  it("gives each reader of a version signing work of their own, reminds at three days, expires it on the next version", async () => {
    const signing = app.get(DocumentsSweep);
    const made = await post("hr", "/documents", { code: DOCUMENT_CODE, title: `Nội quy ${RUN}`, departmentId });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const publish = async (): Promise<string> => {
      const res = await post("hr", `/documents/${made.body.id}/versions`, { body: `Nội quy bản mới ${RUN}` });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      await signing.fanOut(res.body.id as string);
      return res.body.id as string;
    };
    const workOf = (versionId: string) =>
      db.noticeItem.findUnique({ where: { key: itemKey("DOCUMENTS", { id: versionId, part: String(idOf.get("hire")) }) } });

    const first = await publish();
    const open = await workOf(first);
    assert.ok(open && open.state === "OPEN" && open.subjectType === "DOCUMENT", "a reader of a new version got no work");
    const held = await db.notification.findMany({ where: { itemId: open.id }, select: { userId: true } });
    assert.deepEqual(held.map((one) => one.userId), [loginOf.get("hire")], "somebody besides the reader holds their signing work");
    assert.equal(
      await db.noticeItem.count({ where: { queue: "DOCUMENTS", subjectId: first, employeeId: { not: idOf.get("hire") } } }),
      0,
      "a person outside the document's department got work to sign it",
    );

    await signing.sweep(new Date(Date.now() + 3 * DAY_MS));
    await signing.sweep(new Date(Date.now() + 3 * DAY_MS));
    const reminded = await db.notification.findFirstOrThrow({ where: { itemId: open.id } });
    assert.equal(reminded.remindCount, 1, "the third day was said other than once");
    assert.deepEqual(reminded.facts, { daysWaited: 3 });

    await db.employee.update({ where: { id: idOf.get("pay") }, data: { departmentId } });
    await signing.sweep(new Date(Date.now() + 3 * DAY_MS));
    const joined = await db.noticeItem.findUnique({ where: { key: itemKey("DOCUMENTS", { id: first, part: String(idOf.get("pay")) }) } });
    assert.ok(joined, "a reader who joined the audience got no work");
    assert.equal(joined.lastMark, 3, "work opened past the third day still owes that day");
    const told = await db.notification.findFirstOrThrow({ where: { itemId: joined.id } });
    assert.deepEqual([told.readAt, told.remindCount], [null, 0], "a reader who joined past the third day was told twice in one sweep");

    const second = await publish();
    assert.equal((await workOf(first))?.state, "EXPIRED", "work on a superseded version stayed open");
    assert.equal((await workOf(second))?.state, "OPEN", "the next version opened no work");
    await signing.sweep();
    assert.equal((await workOf(first))?.state, "EXPIRED", "work on a superseded version opened again");

    const signed = await post("hire", `/me/documents/${second}/ack`);
    assert.equal(signed.status, 201, JSON.stringify(signed.body));
    const done = await workOf(second);
    assert.deepEqual([done?.state, done?.outcome, done?.actorId], ["DONE", "SIGNED", loginOf.get("hire")]);
  });

  it("opens a reader's signing work again once the document or the reader is back, told once, and never once signed", async () => {
    const signing = app.get(DocumentsSweep);
    const hire = idOf.get("hire") as number;
    const made = await post("hr", "/documents", { code: RETURN_CODE, title: `Quy chế ${RUN}`, departmentId });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    const published = await post("hr", `/documents/${made.body.id}/versions`, { body: `Quy chế ${RUN}` });
    assert.equal(published.status, 201, JSON.stringify(published.body));
    const version = published.body.id as string;
    await signing.fanOut(version);
    const key = itemKey("DOCUMENTS", { id: version, part: String(hire) });
    const current = () => db.noticeItem.findUniqueOrThrow({ where: { key } });
    const toldOnce = async (itemId: string, why: string) => {
      const rows = await db.notification.findMany({ where: { itemId } });
      assert.deepEqual(rows.map((one) => [one.userId, one.readAt, one.remindCount]), [[loginOf.get("hire"), null, 0]], why);
    };
    const aim = (body: object) =>
      request(app.getHttpServer()).patch(`/documents/${made.body.id}`).set("Authorization", `Bearer ${tokenOf.get("hr")}`).send(body);
    const first = await current();
    await db.documentVersion.update({ where: { id: version }, data: { publishedAt: new Date(Date.now() - 4 * DAY_MS) } });

    assert.equal((await aim({ active: false })).status, 200);
    assert.equal((await db.noticeItem.findUniqueOrThrow({ where: { id: first.id } })).state, "EXPIRED", "a retired document kept its work open");
    assert.equal((await aim({ active: true })).status, 200);
    await signing.sweep();
    const back = await current();
    assert.ok(back.id !== first.id && back.state === "OPEN", "a document back in use opened no work for its unsigned reader");
    assert.equal(back.lastMark, 3, "work opened again owes a mark its version already passed");
    await toldOnce(back.id, "work opened again with its document was not told exactly once");
    const aside = await db.noticeItem.findUniqueOrThrow({ where: { id: first.id } });
    assert.deepEqual([aside.key, aside.state], [`${key}:${aside.closedAt?.getTime()}`, "EXPIRED"], "the expired work did not step aside");

    await db.employee.update({ where: { id: hire }, data: { departmentId: null } });
    await signing.sweep();
    assert.equal((await db.noticeItem.findUniqueOrThrow({ where: { id: back.id } })).state, "EXPIRED", "a reader out of the audience kept the work");
    await db.employee.update({ where: { id: hire }, data: { departmentId } });
    await signing.sweep();
    const again = await current();
    assert.ok(again.id !== back.id && again.state === "OPEN", "a reader back in the audience got no work again");
    await toldOnce(again.id, "work opened again with its reader was not told exactly once");

    assert.equal((await post("hire", `/me/documents/${version}/ack`)).status, 201);
    await db.employee.update({ where: { id: hire }, data: { departmentId: null } });
    await signing.sweep();
    await db.employee.update({ where: { id: hire }, data: { departmentId } });
    await signing.sweep();
    const kept = await current();
    assert.deepEqual([kept.id, kept.state, kept.outcome], [again.id, "DONE", "SIGNED"], "signed work opened again");
  });
});
