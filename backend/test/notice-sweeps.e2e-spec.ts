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
import type { InboxQueue } from "../src/modules/notifications/audience.service.js";
import { itemKey } from "../src/modules/notifications/notice-items.service.js";
import { CleanupSweep } from "../src/modules/notifications/sweeps/cleanup.sweep.js";
import { ContractsSweep } from "../src/modules/notifications/sweeps/contracts.sweep.js";
import { ProbationSweep } from "../src/modules/notifications/sweeps/probation.sweep.js";
import { StalledSweep } from "../src/modules/notifications/sweeps/stalled.sweep.js";
import { dayAsDate, localDay } from "../src/modules/timesheet/local-day.js";

const RUN = randomUUID().slice(0, 6);
const PASSWORD = "e2e-notice-sweeps-password";
const PAY_YEAR = 1992;
const PEOPLE = ["asker", "desk", "pay", "boss", "renewed", "ended", "late", "newbie"] as const;
type Who = (typeof PEOPLE)[number];
const ROLE: Record<Who, Role> = {
  asker: "EMPLOYEE",
  desk: "HR",
  pay: "PAYROLL",
  boss: "MANAGER",
  renewed: "EMPLOYEE",
  ended: "EMPLOYEE",
  late: "EMPLOYEE",
  newbie: "EMPLOYEE",
};
const codeOf = (who: Who) => `E2ESW${PEOPLE.indexOf(who)}${RUN}`;
const mailOf = (who: Who) => `e2e-notice-sweeps-${who}-${RUN}@kiosk.local`;
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

describe("the stalled sweep in every inbox queue (e2e)", () => {
  let app: INestApplication;
  let db: PrismaService;
  let stalled: StalledSweep;
  const idOf = new Map<Who, number>();
  const loginOf = new Map<Who, string>();
  const tokenOf = new Map<Who, string>();

  const post = (who: Who, path: string, body: object = {}) =>
    request(app.getHttpServer()).post(path).set("Authorization", `Bearer ${tokenOf.get(who)}`).send(body);

  async function age(table: string, column: string, id: string, days: number): Promise<void> {
    await db.$executeRawUnsafe(`UPDATE "${table}" SET "${column}" = $1 WHERE "id" = $2`, new Date(Date.now() - days * DAY_MS), id);
  }

  // A day counted from the company's today, the calendar the contract sweeps read (KEHOACH 9.8).
  function day(offset: number): Date {
    return new Date(dayAsDate(localDay(new Date(), validateEnv().APP_TIMEZONE)).getTime() + offset * DAY_MS);
  }

  async function contractFor(who: Who, data: { kind: "FIXED_TERM" | "PROBATION"; endDate?: Date; probationEnd?: Date }) {
    return db.employmentContract.create({
      data: { employeeId: idOf.get(who) as number, state: "ACTIVE", startDate: day(-200), ...data },
    });
  }

  async function seatOf(key: string, who: Who) {
    return db.notification.findFirst({ where: { dedupKey: key, userId: loginOf.get(who) } });
  }

  async function itemOf(queue: InboxQueue | "CONTRACTS_DUE" | "PROBATION_DUE", id: string) {
    return db.noticeItem.findUniqueOrThrow({ where: { key: itemKey(queue, id) } });
  }

  function stalledFor(id: string) {
    return db.notification.findFirst({ where: { userId: loginOf.get("asker"), kind: "REQUEST_STALLED", subjectId: id } });
  }

  async function sweep(): Promise<void> {
    await db.payrollPeriod.deleteMany({ where: { year: PAY_YEAR } });
    await db.user.deleteMany({ where: { email: { in: PEOPLE.map(mailOf) } } });
    await db.employee.deleteMany({ where: { code: { in: PEOPLE.map(codeOf) } } });
  }

  before(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    db = app.get(PrismaService);
    stalled = app.get(StalledSweep);
    await sweep();
    for (const who of PEOPLE) {
      const made = await db.employee.create({ data: { code: codeOf(who), fullName: `Quét ${who} ${RUN}`, active: true } });
      idOf.set(who, made.id);
      const login = await db.user.create({
        data: { email: mailOf(who), role: ROLE[who], employeeId: made.id, passwordHash: await hashPassword(PASSWORD) },
      });
      loginOf.set(who, login.id);
    }
    for (const who of PEOPLE) {
      const res = await request(app.getHttpServer()).post("/auth/login").send({ email: mailOf(who), password: PASSWORD });
      tokenOf.set(who, res.body.accessToken as string);
    }
    await db.employee.updateMany({
      where: { id: { in: (["renewed", "ended", "late", "newbie"] as const).map((who) => idOf.get(who) as number) } },
      data: { managerId: idOf.get("boss") },
    });
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("reminds an advance, a letter, a profile change and a dependant at their third day, and tells the asker", async () => {
    const advance = (await post("asker", "/advances", { amount: 500_000, reason: "e2e" })).body.id as string;
    const letter = (await post("asker", "/certificates", { kind: "EMPLOYMENT", purpose: "e2e" })).body.id as string;
    const change = (await post("asker", "/profile-changes", { field: "PHONE", phone: "0900000456" })).body.id as string;
    const dependant = (await post("asker", "/dependents", { fullName: "Con quét", relation: "CHILD", fromMonth: "2036-01-01" })).body
      .id as string;
    await age("SalaryAdvance", "requestedAt", advance, 3);
    await age("Certificate", "createdAt", letter, 3);
    await age("ProfileChange", "createdAt", change, 3);
    await age("Dependent", "createdAt", dependant, 3);
    await stalled.sweep();

    const cases = [
      ["ADVANCES_TO_DECIDE", advance, "desk"],
      ["CERTIFICATES", letter, "desk"],
      ["PROFILE_CHANGES", change, "desk"],
      ["DEPENDENTS", dependant, "pay"],
    ] as const;
    for (const [queue, id, holder] of cases) {
      const item = await itemOf(queue, id);
      assert.equal(item.lastMark, 3, `${queue} did not speak at its third day`);
      const seat = await db.notification.findFirstOrThrow({ where: { itemId: item.id, userId: loginOf.get(holder) } });
      assert.equal(seat.remindCount, 1, `${queue}: ${holder} was not reminded`);
      assert.equal(seat.readAt, null);
      const told = await stalledFor(id);
      assert.equal(told?.daysWaited, 3, `${queue}: the asker was not told how long it has waited`);
    }
  });

  it("says a mark once when two sweeps run at the same time", async () => {
    const letter = (await post("asker", "/certificates", { kind: "INCOME", purpose: "e2e", months: 3 })).body.id as string;
    await age("Certificate", "createdAt", letter, 7);
    await Promise.all([stalled.sweep(), stalled.sweep()]);
    const item = await itemOf("CERTIFICATES", letter);
    assert.equal(item.lastMark, 7);
    const seat = await db.notification.findFirstOrThrow({ where: { itemId: item.id, userId: loginOf.get("desk") } });
    assert.equal(seat.remindCount, 1, "two sweeps both spoke");
    assert.equal((await stalledFor(letter))?.remindCount, 0, "the asker heard the mark twice");
  });

  it("says a missed mark once, at the highest mark passed", async () => {
    const dependant = (await post("asker", "/dependents", { fullName: "Con lỡ mốc", relation: "CHILD", fromMonth: "2036-02-01" })).body
      .id as string;
    await age("Dependent", "createdAt", dependant, 9);
    await stalled.sweep();
    await stalled.sweep();
    assert.equal((await itemOf("DEPENDENTS", dependant)).lastMark, 7);
    const told = await stalledFor(dependant);
    assert.equal(told?.remindCount, 0, "a caught-up mark was said more than once");
    assert.equal(told?.daysWaited, 9);
  });

  it("stays quiet about work already decided", async () => {
    const advance = (await post("asker", "/advances", { amount: 300_000, reason: "e2e" })).body.id as string;
    assert.equal((await post("desk", `/advances/${advance}/decide`, { approve: false, note: "e2e" })).status, 201);
    await age("SalaryAdvance", "requestedAt", advance, 7);
    await stalled.sweep();
    assert.equal((await itemOf("ADVANCES_TO_DECIDE", advance)).lastMark, null, "decided work was reminded");
  });

  it("warns the pay desk of a dispute a day from its due date, then again once overdue", async () => {
    const policy = await db.payrollPolicy.findFirstOrThrow({ orderBy: { effectiveFrom: "asc" } });
    const month = 1 + (Number.parseInt(RUN, 16) % 12);
    const period = await db.payrollPeriod.create({
      data: { year: PAY_YEAR, month, startDate: new Date(Date.UTC(PAY_YEAR, month - 1, 1)), endDate: new Date(Date.UTC(PAY_YEAR, month, 0)) },
    });
    const run = await db.payrollRun.create({ data: { periodId: period.id, kind: "REGULAR", state: "DONE" } });
    const slip = await db.payslip.create({
      data: { runId: run.id, periodId: period.id, employeeId: idOf.get("asker") as number, policyId: policy.id, state: "ISSUED", issuedAt: new Date() },
    });
    const id = (await post("asker", "/payslip-disputes", { payslipId: slip.id, claim: "Thiếu phụ cấp" })).body.id as string;
    await db.payslipDispute.update({ where: { id }, data: { dueAt: new Date(Date.now() + 12 * HOUR_MS) } });
    await stalled.sweep();
    let item = await itemOf("DISPUTES", id);
    assert.equal(item.lastMark, 1, "a dispute due tomorrow was not raised");
    assert.equal(item.level, "ACTION");

    await db.payslipDispute.update({ where: { id }, data: { dueAt: new Date(Date.now() - HOUR_MS) } });
    await stalled.sweep();
    await stalled.sweep();
    item = await itemOf("DISPUTES", id);
    assert.equal(item.lastMark, 2);
    assert.equal(item.level, "WARNING", "an overdue dispute did not turn into a warning");
    const seat = await db.notification.findFirstOrThrow({ where: { itemId: item.id, userId: loginOf.get("pay") } });
    assert.equal(seat.remindCount, 2, "the overdue mark was said other than once");
    const told = await db.notification.findFirst({ where: { userId: loginOf.get("asker"), kind: "REQUEST_STALLED", subjectId: id } });
    const shown = await request(app.getHttpServer()).get(`/notifications/${told?.id}`).set("Authorization", `Bearer ${tokenOf.get("asker")}`);
    assert.deepEqual(shown.body.subject?.parent, { type: "PAYSLIP", id: slip.id }, "the asker's notice does not open the disputed payslip");
  });

  it("opens contract work for the desk a month out, reminds at 15, warns at 7 once, and closes it renewed", async () => {
    const contracts = app.get(ContractsSweep);
    const held = await contractFor("renewed", { kind: "FIXED_TERM", endDate: day(30) });
    await contracts.sweep();
    let item = await itemOf("CONTRACTS_DUE", held.id);
    assert.equal(item.lastMark, 1, "a contract a month from its end opened no work");
    assert.equal(item.level, "ACTION");
    assert.equal((await seatOf(item.key, "desk"))?.readAt, null, "the desk was not told");
    assert.equal(await seatOf(item.key, "renewed"), null, "the signer sits in the group of their own contract");
    const signer = await db.notification.findFirst({ where: { kind: "CONTRACT_ENDING", subjectId: held.id } });
    assert.equal(signer?.daysLeft, 30, "the signer's own notice was not written");

    await db.employmentContract.update({ where: { id: held.id }, data: { endDate: day(15) } });
    await contracts.sweep();
    assert.equal((await itemOf("CONTRACTS_DUE", held.id)).lastMark, 2);
    assert.equal((await seatOf(item.key, "desk"))?.remindCount, 1, "the fifteen-day mark was not said");

    await db.employmentContract.update({ where: { id: held.id }, data: { endDate: day(7) } });
    await Promise.all([contracts.sweep(), contracts.sweep()]);
    item = await itemOf("CONTRACTS_DUE", held.id);
    assert.equal(item.lastMark, 3);
    assert.equal(item.level, "WARNING", "a week out did not turn into a warning");
    assert.equal((await seatOf(item.key, "desk"))?.remindCount, 2, "two sweeps both said the seven-day mark");

    const renewal = await post("desk", "/contracts", { employeeId: idOf.get("renewed"), kind: "FIXED_TERM", startDate: day(8).toISOString().slice(0, 10), endDate: day(400).toISOString().slice(0, 10) });
    assert.equal(renewal.status, 201, JSON.stringify(renewal.body));
    const signed = await request(app.getHttpServer())
      .patch(`/contracts/${renewal.body.id}`)
      .set("Authorization", `Bearer ${tokenOf.get("desk")}`)
      .send({ state: "ACTIVE" });
    assert.equal(signed.status, 200, JSON.stringify(signed.body));
    item = await itemOf("CONTRACTS_DUE", held.id);
    assert.equal(item.state, "DONE", "a renewed contract left its work open");
    assert.equal(item.outcome, "RENEWED");
    assert.equal(item.actorId, loginOf.get("desk"));
    assert.ok((await seatOf(item.key, "desk"))?.readAt, "the desk still has the renewed contract unread");
  });

  it("clears contract work when the contract ends without a new one", async () => {
    const held = await contractFor("ended", { kind: "FIXED_TERM", endDate: day(20) });
    await app.get(ContractsSweep).sweep();
    const ended = await request(app.getHttpServer())
      .patch(`/contracts/${held.id}`)
      .set("Authorization", `Bearer ${tokenOf.get("desk")}`)
      .send({ state: "TERMINATED", note: "e2e" });
    assert.equal(ended.status, 200, JSON.stringify(ended.body));
    const item = await itemOf("CONTRACTS_DUE", held.id);
    assert.equal(item.state, "CLEARED");
    assert.equal(item.outcome, null);
  });

  it("opens late contract work at the highest mark passed and tells it once", async () => {
    const held = await contractFor("late", { kind: "FIXED_TERM", endDate: day(6) });
    await app.get(ContractsSweep).sweep();
    await app.get(ContractsSweep).sweep();
    const item = await itemOf("CONTRACTS_DUE", held.id);
    assert.equal(item.lastMark, 3);
    assert.equal(item.level, "WARNING");
    const seat = await seatOf(item.key, "desk");
    assert.ok(seat && seat.readAt === null, "late work was not told");
    assert.equal(seat.remindCount, 0, "work told on opening was reminded in the same breath");
  });

  it("opens probation work for the desk and the direct manager; only the desk closes it by hand, on the record", async () => {
    const held = await contractFor("newbie", { kind: "PROBATION", probationEnd: day(7) });
    await app.get(ProbationSweep).sweep();
    const item = await itemOf("PROBATION_DUE", held.id);
    assert.equal(item.state, "OPEN");
    assert.ok(await seatOf(item.key, "desk"), "the desk was not told of a probation ending");
    assert.ok(await seatOf(item.key, "boss"), "the direct manager was not told of a probation ending");

    const path = `/notifications/items/${encodeURIComponent(item.key)}/resolve`;
    const manager = await post("boss", path, { note: "Đã đạt" });
    assert.equal(manager.status, 409);
    assert.equal(manager.body.message, "NOTICE_ITEM_NOT_RESOLVABLE");
    const closed = await post("desk", path, { note: "Đã ký hợp đồng chính thức" });
    assert.equal(closed.status, 201, JSON.stringify(closed.body));
    assert.equal(closed.body.state, "DONE");
    assert.equal(closed.body.outcome, "RESOLVED");
    const trail = await db.auditLog.findFirst({ where: { action: "notice.resolve", subjectId: String(idOf.get("newbie")) } });
    assert.equal((trail?.meta as { note?: string } | null)?.note, "Đã ký hợp đồng chính thức", "closing by hand left no audit");
    assert.equal((await post("desk", path, { note: "again" })).status, 409, "closed work closed twice");
  });

  it("cleans news read and work closed past the keep, and never touches open work", async () => {
    const long = new Date(Date.now() - 400 * DAY_MS);
    const asker = loginOf.get("asker") as string;
    const news = (readAt: Date | null) =>
      db.notification.create({
        data: { userId: asker, kind: "PAYSLIP_ISSUED", dedupKey: `payslip-issued:row:${randomUUID()}`, readAt, createdAt: long },
      });
    const work = async (closed: boolean) => {
      const subjectId = randomUUID();
      const item = await db.noticeItem.create({
        data: {
          key: itemKey("REQUESTS", subjectId),
          queue: "REQUESTS",
          subjectType: "REQUEST",
          subjectId,
          employeeId: idOf.get("asker"),
          openedAt: long,
          ...(closed ? { state: "DONE" as const, outcome: "APPROVED" as const, closedAt: long } : {}),
        },
      });
      const row = await db.notification.create({
        data: { userId: loginOf.get("desk") as string, kind: "REQUEST_WAITING", itemId: item.id, dedupKey: item.key, readAt: long, createdAt: long },
      });
      return { item, row };
    };
    const [read, unread, open, closed] = [await news(long), await news(null), await work(false), await work(true)];
    await app.get(CleanupSweep).sweep();
    const has = async (id: string) => (await db.notification.count({ where: { id } })) === 1;
    assert.equal(await has(read.id), false, "a notice read long ago stayed");
    assert.equal(await has(unread.id), true, "a notice nobody read was cleaned");
    assert.equal(await has(open.row.id), true, "a row of open work was cleaned");
    assert.equal(await db.noticeItem.count({ where: { id: open.item.id } }), 1, "open work was cleaned");
    assert.equal(await db.noticeItem.count({ where: { id: closed.item.id } }), 0, "work closed long ago stayed");
    assert.equal(await has(closed.row.id), false, "a row of work closed long ago stayed");
  });
});
