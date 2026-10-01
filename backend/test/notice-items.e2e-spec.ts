import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import type { NoticeItem, Role } from "@prisma/client";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { hashPassword } from "../src/modules/auth/password.js";
import type { InboxQueue } from "../src/modules/notifications/audience.service.js";
import { itemKey, NoticeItemsService } from "../src/modules/notifications/notice-items.service.js";

const RUN = randomUUID().slice(0, 6);
const PASSWORD = "e2e-items-password";
const PAY_YEAR = 1994;
const PEOPLE = ["asker", "orphan", "mover", "boss", "next", "deskA", "deskB", "pay"] as const;
type Who = (typeof PEOPLE)[number];
const ROLE: Record<Who, Role> = {
  asker: "EMPLOYEE",
  orphan: "EMPLOYEE",
  mover: "EMPLOYEE",
  boss: "MANAGER",
  next: "MANAGER",
  deskA: "HR",
  deskB: "HR",
  pay: "PAYROLL",
};
const codeOf = (who: Who) => `E2EIT${PEOPLE.indexOf(who)}${RUN}`;
const mailOf = (who: Who) => `e2e-items-${who.toLowerCase()}-${RUN}@kiosk.local`;
const nameOf = (who: Who) => `Việc ${who} ${RUN}`;

interface Bell {
  id: string;
  item: { key: string; state: string; outcome: string | null; actorId: string | null; actorName: string | null; openedAt: string } | null;
}

describe("work a group shares, closed once for all (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let items: NoticeItemsService;
  const idOf = new Map<Who, number>();
  const loginOf = new Map<Who, string>();
  const tokenOf = new Map<Who, string>();
  let periodId = "";
  let day = 0;
  // The record behind each queue's work, and the holder who must be able to open it.
  const records: { path: string; holder: Who; decidedBy: Who }[] = [];

  const post = (who: Who, path: string, body: object = {}) =>
    request(http).post(path).set("Authorization", `Bearer ${tokenOf.get(who)}`).send(body);

  // Each filing takes its own day, so no two of one person's requests overlap.
  async function fileRequest(who: Who): Promise<string> {
    day += 1;
    const on = `2036-08-${String(day).padStart(2, "0")}`;
    const res = await post(who, "/requests", { kind: "REMOTE_WORK", fromDate: on, toDate: on, reason: "e2e" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.id as string;
  }

  async function itemOf(queue: InboxQueue, subjectId: string): Promise<NoticeItem> {
    return db.noticeItem.findUniqueOrThrow({ where: { key: itemKey(queue, subjectId) } });
  }

  async function seatOf(item: NoticeItem, who: Who) {
    return db.notification.findUnique({ where: { userId_dedupKey: { userId: loginOf.get(who) as string, dedupKey: item.key } } });
  }

  async function closedFor(item: NoticeItem, by: Who, state: string, outcome: string | null): Promise<void> {
    const shut = await db.noticeItem.findUniqueOrThrow({ where: { id: item.id } });
    assert.equal(shut.state, state);
    assert.equal(shut.outcome, outcome);
    assert.equal(shut.actorId, loginOf.get(by), "the item does not say who closed it");
    assert.ok(shut.closedAt, "a closed item has no time of closing");
    const unread = await db.notification.count({ where: { itemId: item.id, readAt: null } });
    assert.equal(unread, 0, "somebody still has finished work unread");
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
    http = app.getHttpServer();
    db = app.get(PrismaService);
    items = app.get(NoticeItemsService);
    await sweep();

    for (const who of PEOPLE) {
      const made = await db.employee.create({ data: { code: codeOf(who), fullName: nameOf(who), active: true } });
      idOf.set(who, made.id);
      const login = await db.user.create({
        data: { email: mailOf(who), role: ROLE[who], employeeId: made.id, passwordHash: await hashPassword(PASSWORD) },
      });
      loginOf.set(who, login.id);
    }
    for (const who of ["asker", "mover"] as const) {
      await db.employee.update({ where: { id: idOf.get(who) }, data: { managerId: idOf.get("boss") } });
    }
    for (const who of PEOPLE) {
      const res = await request(http).post("/auth/login").send({ email: mailOf(who), password: PASSWORD });
      assert.equal(res.status, 200, `${who} could not sign in`);
      tokenOf.set(who, res.body.accessToken as string);
    }
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("opens one item when a request is filed, and seats the manager rather than the asker", async () => {
    const id = await fileRequest("asker");
    const item = await itemOf("REQUESTS", id);
    assert.equal(item.state, "OPEN");
    assert.equal(item.employeeId, idOf.get("asker"));
    const boss = await seatOf(item, "boss");
    assert.ok(boss, "the manager was not told");
    assert.equal(boss.readAt, null);
    assert.equal(await seatOf(item, "asker"), null, "the asker sits in the group of their own request");
  });

  it("closes it once for the whole group, shows who decided, and tells the asker once", async () => {
    const id = await fileRequest("asker");
    const item = await itemOf("REQUESTS", id);
    const res = await post("boss", `/requests/${id}/decide`, { approve: true });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    await closedFor(item, "boss", "DONE", "APPROVED");

    const bell = await request(http).get("/notifications").set("Authorization", `Bearer ${tokenOf.get("boss")}`);
    const row = (bell.body.rows as Bell[]).find((one) => one.item?.key === item.key);
    assert.equal(row?.item?.state, "DONE", "the bell does not show the work as done");
    assert.equal(row?.item?.actorName, nameOf("boss"), "the bell does not say who decided");
    assert.equal(row?.item?.actorId, loginOf.get("boss"), "the bell cannot tell its reader they decided it");
    assert.equal(row?.item?.openedAt, item.openedAt.toISOString(), "the bell cannot count how long the work waited");

    const late = await post("deskA", `/requests/${id}/decide`, { approve: false, note: "e2e" });
    assert.equal(late.status, 409, "a second decision was not answered as already handled");
    const told = await db.notification.count({ where: { userId: loginOf.get("asker"), kind: "REQUEST_DECIDED", requestId: id } });
    assert.equal(told, 1, "the asker heard the decision other than once");
  });

  it("lets two desks race: one wins, the other gets 409, and the asker hears once", async () => {
    const id = await fileRequest("orphan");
    const item = await itemOf("REQUESTS", id);
    assert.ok(await seatOf(item, "deskA"), "a request with nobody above did not reach the desk");
    const answers = await Promise.all([
      post("deskA", `/requests/${id}/decide`, { approve: true }),
      post("deskB", `/requests/${id}/decide`, { approve: true }),
    ]);
    assert.deepEqual(answers.map((one) => one.status).sort(), [201, 409]);
    const winner = answers[0].status === 201 ? "deskA" : "deskB";
    await closedFor(item, winner, "DONE", "APPROVED");
    const told = await db.notification.count({ where: { userId: loginOf.get("orphan"), kind: "REQUEST_DECIDED", requestId: id } });
    assert.equal(told, 1);
  });

  it("closes the manager's row when the desk decides in the manager's place", async () => {
    const id = await fileRequest("asker");
    const item = await itemOf("REQUESTS", id);
    const res = await post("deskA", `/requests/${id}/decide`, { approve: false, note: "e2e" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    await closedFor(item, "deskA", "DONE", "REJECTED");
    assert.ok((await seatOf(item, "boss"))?.readAt, "the manager's row stayed unread");
  });

  it("closes the item as withdrawn when the asker takes the request back", async () => {
    const id = await fileRequest("asker");
    const item = await itemOf("REQUESTS", id);
    const res = await post("asker", `/requests/${id}/cancel`);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    await closedFor(item, "asker", "WITHDRAWN", null);
    const late = await post("boss", `/requests/${id}/decide`, { approve: true });
    assert.equal(late.status, 409);
  });

  it("moves a waiting request with its person: the old manager is left, the new one is told and reminded", async () => {
    const id = await fileRequest("mover");
    const item = await itemOf("REQUESTS", id);
    const moved = await request(http)
      .patch(`/employees/${idOf.get("mover")}`)
      .set("Authorization", `Bearer ${tokenOf.get("deskA")}`)
      .send({ managerId: idOf.get("next") });
    assert.equal(moved.status, 200, JSON.stringify(moved.body));
    assert.equal((await itemOf("REQUESTS", id)).state, "OPEN", "moving the approver closed the work");
    assert.ok((await seatOf(item, "boss"))?.leftAt, "the old manager still holds the request");
    const next = await seatOf(item, "next");
    assert.ok(next && next.readAt === null && next.leftAt === null, "the new manager was not told");

    assert.ok(await items.claimMark("REQUESTS", id, 3));
    await items.remind("REQUESTS", id, { daysWaited: 3 });
    assert.equal((await seatOf(item, "next"))?.remindCount, 1, "the reminder missed the new manager");
    assert.equal((await seatOf(item, "boss"))?.remindCount, 0, "the reminder reached the manager it left");

    const res = await post("next", `/requests/${id}/decide`, { approve: true });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    await closedFor(item, "next", "DONE", "APPROVED");
  });

  it("runs an advance through both desks: decided, then paid", async () => {
    const res = await post("asker", "/advances", { amount: 1_000_000, reason: "e2e" });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const id = res.body.id as string;
    const deciding = await itemOf("ADVANCES_TO_DECIDE", id);
    assert.ok(await seatOf(deciding, "deskA"), "the desk that decides advances was not told");
    assert.equal(await seatOf(deciding, "boss"), null, "a manager was told of somebody's pay");

    const answers = await Promise.all([
      post("deskA", `/advances/${id}/decide`, { approve: true }),
      post("deskB", `/advances/${id}/decide`, { approve: true }),
    ]);
    assert.deepEqual(answers.map((one) => one.status).sort(), [201, 409]);
    await closedFor(deciding, answers[0].status === 201 ? "deskA" : "deskB", "DONE", "APPROVED");

    const paying = await itemOf("ADVANCES_TO_PAY", id);
    assert.equal(paying.state, "OPEN");
    const payRow = await seatOf(paying, "pay");
    assert.ok(payRow && payRow.readAt === null, "the paying desk was not told");
    assert.equal(payRow.approved, true);
    const paid = await post("pay", `/advances/${id}/paid`);
    assert.equal(paid.status, 201, JSON.stringify(paid.body));
    await closedFor(paying, "pay", "DONE", "PAID");
    assert.equal((await post("pay", `/advances/${id}/paid`)).status, 409);
    records.push({ path: `/advances/${id}`, holder: "deskA", decidedBy: answers[0].status === 201 ? "deskA" : "deskB" });
  });

  it("closes a letter when it is issued, and as withdrawn when its asker takes it back", async () => {
    const asked = await post("asker", "/certificates", { kind: "EMPLOYMENT", purpose: "e2e" });
    assert.equal(asked.status, 201, JSON.stringify(asked.body));
    const issuing = await itemOf("CERTIFICATES", asked.body.id as string);
    assert.ok(await seatOf(issuing, "pay"), "a desk that issues letters was not told");
    assert.equal((await post("deskA", `/certificates/${asked.body.id}/issue`)).status, 201);
    await closedFor(issuing, "deskA", "DONE", "ISSUED");
    records.push({ path: `/certificates/${asked.body.id}`, holder: "pay", decidedBy: "deskA" });

    const again = await post("asker", "/certificates", { kind: "INCOME", purpose: "e2e", months: 3 });
    const withdrawing = await itemOf("CERTIFICATES", again.body.id as string);
    assert.equal((await post("asker", `/certificates/${again.body.id}/cancel`)).status, 201);
    await closedFor(withdrawing, "asker", "WITHDRAWN", null);
  });

  it("closes a profile change when the desk answers it", async () => {
    const asked = await post("asker", "/profile-changes", { field: "PHONE", phone: "0900000123" });
    assert.equal(asked.status, 201, JSON.stringify(asked.body));
    const item = await itemOf("PROFILE_CHANGES", asked.body.id as string);
    assert.ok(await seatOf(item, "deskB"));
    assert.equal((await post("deskB", `/profile-changes/${asked.body.id}/approve`)).status, 201);
    await closedFor(item, "deskB", "DONE", "APPROVED");
    records.push({ path: `/profile-changes/${asked.body.id}`, holder: "deskA", decidedBy: "deskB" });
  });

  it("closes a dependant's registration when the pay desk decides it", async () => {
    const filed = await post("asker", "/dependents", { fullName: "Con thử", relation: "CHILD", fromMonth: "2036-01-01" });
    assert.equal(filed.status, 201, JSON.stringify(filed.body));
    const item = await itemOf("DEPENDENTS", filed.body.id as string);
    assert.ok(await seatOf(item, "pay"));
    assert.equal(await seatOf(item, "deskA"), null, "the HR desk was told of a pay-desk queue");
    assert.equal((await post("pay", `/dependents/${filed.body.id}/decide`, { approve: true })).status, 201);
    await closedFor(item, "pay", "DONE", "APPROVED");
    records.push({ path: `/dependents/${filed.body.id}`, holder: "pay", decidedBy: "pay" });
  });

  it("keys a dispute by its own id and closes it with the answer's outcome", async () => {
    const policy = await db.payrollPolicy.findFirstOrThrow({ orderBy: { effectiveFrom: "asc" } });
    const month = 1 + (Number.parseInt(RUN, 16) % 12);
    const period = await db.payrollPeriod.create({
      data: {
        year: PAY_YEAR,
        month,
        startDate: new Date(Date.UTC(PAY_YEAR, month - 1, 1)),
        endDate: new Date(Date.UTC(PAY_YEAR, month, 0)),
      },
    });
    periodId = period.id;
    const run = await db.payrollRun.create({ data: { periodId, kind: "REGULAR", state: "DONE" } });
    const slip = await db.payslip.create({
      data: { runId: run.id, periodId, employeeId: idOf.get("asker") as number, policyId: policy.id, state: "ISSUED", issuedAt: new Date() },
    });
    const raised = await post("asker", "/payslip-disputes", { payslipId: slip.id, claim: "Thiếu một ngày công" });
    assert.equal(raised.status, 201, JSON.stringify(raised.body));
    const id = raised.body.id as string;
    const item = await itemOf("DISPUTES", id);
    const payRow = await seatOf(item, "pay");
    assert.equal(payRow?.payslipId, slip.id, "the desk's row lost the slip the bell opens");

    const answered = await post("pay", `/payslip-disputes/${id}/answer`, { outcome: "REJECTED", answer: "Đã đối chiếu" });
    assert.equal(answered.status, 201, JSON.stringify(answered.body));
    await closedFor(item, "pay", "DONE", "REJECTED");
    const news = await db.notification.findFirstOrThrow({ where: { userId: loginOf.get("asker"), kind: "DISPUTE_ANSWERED" } });
    assert.equal(news.subjectType, "DISPUTE");
    assert.equal(news.subjectId, id);
    assert.deepEqual(news.facts, { outcome: "REJECTED" });
    records.push({ path: `/payslip-disputes/${id}`, holder: "pay", decidedBy: "pay" });
  });

  it("opens the record behind each queue's work for its holders and says who handled it, and for nobody outside", async () => {
    assert.equal(records.length, 5, "a queue's walk above did not finish");
    for (const one of records) {
      const held = await request(http).get(one.path).set("Authorization", `Bearer ${tokenOf.get(one.holder)}`);
      assert.equal(held.status, 200, `${one.holder} could not open ${one.path}`);
      assert.equal(held.body.decidedByName, nameOf(one.decidedBy), `${one.path} does not say who handled it`);
      const outside = await request(http).get(one.path).set("Authorization", `Bearer ${tokenOf.get("orphan")}`);
      assert.equal(outside.status, 404, `somebody outside opened ${one.path}`);
      const own = await request(http).get(one.path).set("Authorization", `Bearer ${tokenOf.get("asker")}`);
      assert.equal(own.status, 200, `the asker could not open their own ${one.path}`);
    }
  });

  it("shows an item to its group with whom it reached, to its asker without, and to nobody else", async () => {
    const asked = await post("asker", "/certificates", { kind: "EMPLOYMENT", purpose: "e2e" });
    const key = itemKey("CERTIFICATES", asked.body.id as string);
    const path = `/notifications/items/${encodeURIComponent(key)}`;
    const desk = await request(http).get(path).set("Authorization", `Bearer ${tokenOf.get("deskA")}`);
    assert.equal(desk.status, 200, JSON.stringify(desk.body));
    assert.equal(desk.body.state, "OPEN");
    assert.equal(desk.body.claimable, true);
    assert.ok((desk.body.holders as { name: string }[]).some((one) => one.name === nameOf("deskA")));
    const own = await request(http).get(path).set("Authorization", `Bearer ${tokenOf.get("asker")}`);
    assert.equal(own.status, 200);
    assert.equal(own.body.holders, null, "the asker saw who in the desk was told");
    for (const who of ["orphan", "boss"] as const) {
      const res = await request(http).get(path).set("Authorization", `Bearer ${tokenOf.get(who)}`);
      assert.equal(res.status, 404, `${who} read an item outside their reach`);
    }
    await post("asker", `/certificates/${asked.body.id}/cancel`);
  });

  it("lets a member say they are on a letter, lets each let go of only their own, and refuses once it is done", async () => {
    const asked = await post("asker", "/certificates", { kind: "EMPLOYMENT", purpose: "e2e" });
    const claim = `/notifications/items/${encodeURIComponent(itemKey("CERTIFICATES", asked.body.id as string))}/claim`;
    const taken = await post("deskA", claim);
    assert.equal(taken.status, 201, JSON.stringify(taken.body));
    assert.equal(taken.body.claimedByName, nameOf("deskA"));
    const notTheirs = await request(http).delete(claim).set("Authorization", `Bearer ${tokenOf.get("deskB")}`);
    assert.equal(notTheirs.body.claimedByName, nameOf("deskA"), "a member let go of somebody else's claim");
    const freed = await request(http).delete(claim).set("Authorization", `Bearer ${tokenOf.get("deskA")}`);
    assert.equal(freed.body.claimedByName, null);
    assert.equal((await post("boss", claim)).status, 404, "somebody outside the group claimed the work");
    assert.equal((await post("deskA", `/certificates/${asked.body.id}/issue`)).status, 201);
    const late = await post("deskB", claim);
    assert.equal(late.status, 409);
    assert.equal(late.body.message, "NOTICE_ITEM_CLOSED");
  });

  it("offers no claim on a request and closes no inbox work by hand", async () => {
    const id = await fileRequest("asker");
    const key = encodeURIComponent(itemKey("REQUESTS", id));
    assert.equal((await post("boss", `/notifications/items/${key}/claim`)).status, 404, "a one-click request took a claim");
    const resolved = await post("boss", `/notifications/items/${key}/resolve`, { note: "e2e" });
    assert.equal(resolved.status, 409);
    assert.equal(resolved.body.message, "NOTICE_ITEM_NOT_RESOLVABLE");
    assert.equal((await post("boss", `/notifications/items/${key}/resolve`, {})).status, 400, "a close with no note was taken");
    assert.equal((await post("orphan", `/notifications/items/${key}/resolve`, { note: "e2e" })).status, 404);
    await post("asker", `/requests/${id}/cancel`);
  });
});
