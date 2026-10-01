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
import { AuthService } from "../src/modules/auth/auth.service.js";
import { hashPassword } from "../src/modules/auth/password.js";
import { QUEUE_DESKS } from "../src/modules/leave/queue-filter.js";
import { AudienceService, type InboxQueue } from "../src/modules/notifications/audience.service.js";
import { INBOX_ROLES } from "../src/modules/notifications/notice-kinds.js";
import { NotificationsService } from "../src/modules/notifications/notifications.service.js";

const RUN = randomUUID().slice(0, 6);
const PASSWORD = "e2e-audience-password";
const SEEDED = ["admin", "viewer", "hr", "payroll", "manager", "employee"] as const;
const CODE = { subject: `E2EAU${RUN}`, boss: `E2EAB${RUN}`, payroll: `E2EAP${RUN}`, clerk: `E2EAC${RUN}`, gone: `E2EAG${RUN}` };
const MAIL = { boss: `e2e-au-boss-${RUN}@kiosk.local`, payroll: `e2e-au-pay-${RUN}@kiosk.local`, clerk: `e2e-au-clerk-${RUN}@kiosk.local` };
const DAY_MS = 86_400_000;

// The list each approvals tab reads, with its waiting state (frontend approvals page).
const TAB: Record<InboxQueue, { path: string; state?: string; roles: readonly Role[] }> = {
  REQUESTS: { path: "/requests/inbox", roles: INBOX_ROLES },
  ADVANCES_TO_DECIDE: { path: "/advances", state: "PENDING", roles: QUEUE_DESKS.advancesToDecide },
  ADVANCES_TO_PAY: { path: "/advances", state: "APPROVED", roles: QUEUE_DESKS.advancesToPay },
  CERTIFICATES: { path: "/certificates", state: "REQUESTED", roles: QUEUE_DESKS.certificates },
  PROFILE_CHANGES: { path: "/profile-changes", state: "PENDING", roles: QUEUE_DESKS.profileChanges },
  DISPUTES: { path: "/payslip-disputes", state: "OPEN", roles: QUEUE_DESKS.disputes },
  DEPENDENTS: { path: "/dependents", state: "PENDING", roles: QUEUE_DESKS.dependents },
};

interface Account {
  name: string;
  userId: string;
  role: Role;
  token: string;
}

describe("who a piece of work waits on (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let audience: AudienceService;
  const accounts: Account[] = [];
  const subjects: { label: string; queue: InboxQueue; id: string }[] = [];
  let periodId = "";

  async function person(code: string, managerId: number | null = null): Promise<number> {
    return (await db.employee.create({ data: { code, fullName: `Thử nhóm ${code}`, active: true, managerId } })).id;
  }

  async function login(email: string, role: Role, employeeId: number): Promise<void> {
    await db.user.create({ data: { email, role, employeeId, passwordHash: await hashPassword(PASSWORD) } });
  }

  async function sweep(): Promise<void> {
    if (periodId) {
      await db.payrollPeriod.deleteMany({ where: { id: periodId } });
    }
    await db.user.deleteMany({ where: { email: { in: Object.values(MAIL) } } });
    await db.employee.deleteMany({ where: { code: { in: Object.values(CODE) } } });
  }

  async function inboxShows(account: Account, queue: InboxQueue, id: string): Promise<boolean> {
    const tab = TAB[queue];
    if (!tab.roles.includes(account.role)) {
      return false;
    }
    const query = new URLSearchParams({ take: "50", search: CODE.subject, ...(tab.state ? { state: tab.state } : {}) });
    const res = await request(http).get(`${tab.path}?${query}`).set("Authorization", `Bearer ${account.token}`);
    if (res.status !== 200) {
      return false;
    }
    return (res.body.rows as { id: string }[]).some((row) => row.id === id);
  }

  before(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    http = app.getHttpServer();
    db = app.get(PrismaService);
    audience = app.get(AudienceService);
    await sweep();

    const boss = await person(CODE.boss);
    const payroll = await person(CODE.payroll);
    const clerk = await person(CODE.clerk);
    const gone = await person(CODE.gone);
    const subject = await person(CODE.subject, boss);
    await login(MAIL.boss, "MANAGER", boss);
    await login(MAIL.payroll, "PAYROLL", payroll);
    await login(MAIL.clerk, "EMPLOYEE", clerk);
    const today = new Date(new Date().toISOString().slice(0, 10));
    // Two stand-ins today: one whose role opens the inbox, one whose role does not (KEHOACH 9.21.4).
    await db.approvalDelegation.createMany({
      data: [
        { fromId: boss, toId: payroll, fromDate: new Date(today.getTime() - DAY_MS), toDate: new Date(today.getTime() + DAY_MS) },
        { fromId: boss, toId: clerk, fromDate: new Date(today.getTime() - DAY_MS), toDate: new Date(today.getTime() + DAY_MS) },
      ],
    });

    const asking = { employeeId: subject, kind: "OVERTIME" as const, state: "PENDING" as const, fromDate: today, toDate: today, reason: "Thử nhóm" };
    const filed = async (label: string, approverId: number | null, createdAt = new Date()) => {
      const made = await db.request.create({ data: { ...asking, approverId, createdAt } });
      subjects.push({ label, queue: "REQUESTS", id: made.id });
    };
    await filed("a request its manager answers", boss);
    await filed("a request with nobody above", null);
    await filed("a request whose manager cannot sign in", gone);
    await filed("a request past its seventh day", boss, new Date(Date.now() - 8 * DAY_MS));

    const advance = async (label: string, queue: InboxQueue, state: "PENDING" | "APPROVED") => {
      const made = await db.salaryAdvance.create({ data: { employeeId: subject, amount: 1_000_000, reason: "Thử", state } });
      subjects.push({ label, queue, id: made.id });
    };
    await advance("an advance to decide", "ADVANCES_TO_DECIDE", "PENDING");
    await advance("an advance to pay", "ADVANCES_TO_PAY", "APPROVED");
    const letter = await db.certificate.create({ data: { employeeId: subject, kind: "EMPLOYMENT", purpose: "Thử" } });
    subjects.push({ label: "a letter", queue: "CERTIFICATES", id: letter.id });
    const hr = await db.user.findUniqueOrThrow({ where: { email: "hr@kiosk.local" } });
    const change = await db.profileChange.create({
      data: { employeeId: subject, field: "PHONE", newValue: { phone: "0900000000" }, askedById: hr.id },
    });
    subjects.push({ label: "a change HR asked for on someone's behalf", queue: "PROFILE_CHANGES", id: change.id });
    const dependent = await db.dependent.create({
      data: { employeeId: subject, fullName: "Con thử", relation: "CHILD", fromMonth: new Date("2026-01-01") },
    });
    subjects.push({ label: "a dependant", queue: "DEPENDENTS", id: dependent.id });
    const policy = await db.payrollPolicy.findFirstOrThrow({ orderBy: { effectiveFrom: "asc" } });
    const period = await db.payrollPeriod.create({
      data: { year: 2039, month: 1 + (Number.parseInt(RUN, 16) % 12), startDate: new Date("2039-01-01"), endDate: new Date("2039-01-31") },
    });
    periodId = period.id;
    const run = await db.payrollRun.create({ data: { periodId } });
    const slip = await db.payslip.create({ data: { runId: run.id, periodId, employeeId: subject, policyId: policy.id } });
    const dispute = await db.payslipDispute.create({
      data: { payslipId: slip.id, employeeId: subject, claim: "Thử", dueAt: new Date(Date.now() + 5 * DAY_MS) },
    });
    subjects.push({ label: "a dispute", queue: "DISPUTES", id: dispute.id });

    const auth = app.get(AuthService);
    const seeded = validateEnv().SEED_ADMIN_PASSWORD ?? "";
    for (const name of SEEDED) {
      const email = `${name}@kiosk.local`;
      const user = await db.user.findUniqueOrThrow({ where: { email } });
      accounts.push({ name, userId: user.id, role: user.role, token: (await auth.signIn(email, seeded, {})).accessToken });
    }
    for (const [name, email] of Object.entries(MAIL)) {
      const user = await db.user.findUniqueOrThrow({ where: { email } });
      accounts.push({ name, userId: user.id, role: user.role, token: (await auth.signIn(email, PASSWORD, {})).accessToken });
    }
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("tells exactly the people whose inbox shows the work, for every queue and every role", async () => {
    const known = new Set(accounts.map((one) => one.userId));
    for (const subject of subjects) {
      const told = new Set((await audience.audienceOf(subject.queue, subject.id)).filter((id) => known.has(id)));
      const shown = new Set<string>();
      for (const account of accounts) {
        if (await inboxShows(account, subject.queue, subject.id)) {
          shown.add(account.userId);
        }
      }
      const name = (ids: Set<string>) => accounts.filter((one) => ids.has(one.userId)).map((one) => one.name).sort();
      assert.deepEqual(name(told), name(shown), `${subject.label}: told and shown differ`);
      assert.ok(told.size > 0, `${subject.label}: nobody was told`);
    }
  });

  it("names the people the plan expects for each request", async () => {
    const names = async (label: string) => {
      const subject = subjects.find((one) => one.label === label);
      assert.ok(subject);
      const told = new Set(await audience.audienceOf(subject.queue, subject.id));
      return accounts.filter((one) => told.has(one.userId)).map((one) => one.name).sort();
    };
    assert.deepEqual(await names("a request its manager answers"), ["boss", "payroll"], "today's stand-in or the manager missing");
    assert.deepEqual(await names("a request with nobody above"), ["admin", "hr"]);
    assert.deepEqual(await names("a request whose manager cannot sign in"), ["admin", "hr"]);
    assert.deepEqual(await names("a request past its seventh day"), ["admin", "boss", "hr", "payroll"]);
    assert.deepEqual(await names("a change HR asked for on someone's behalf"), ["admin"], "the asker was told of their own ask");
  });

  it("never tells a manager about pay work", async () => {
    const managers = new Set(accounts.filter((one) => one.role === "MANAGER").map((one) => one.userId));
    for (const subject of subjects.filter((one) => one.queue !== "REQUESTS")) {
      const told = await audience.audienceOf(subject.queue, subject.id);
      assert.ok(!told.some((id) => managers.has(id)), `${subject.label} reached a manager`);
    }
  });

  it("offers each account only the kinds it can receive, and keeps a work item's in-app switch on", async () => {
    const as = (name: string) => accounts.find((one) => one.name === name) as Account;
    const read = async (name: string) =>
      (await request(http).get("/notifications/preferences").set("Authorization", `Bearer ${as(name).token}`)).body as {
        kind: string;
        channel: string;
        mutable: boolean;
      }[];
    const employee = await read("employee");
    assert.ok(!employee.some((row) => row.kind === "REQUEST_WAITING"), "an employee was offered work they never get");
    assert.ok(employee.some((row) => row.kind === "PAYSLIP_ISSUED"));
    const viewer = await read("viewer");
    assert.ok(!viewer.some((row) => row.kind === "PAYSLIP_ISSUED"), "an account with no record was offered a payslip");
    const hr = await read("hr");
    assert.equal(hr.find((row) => row.kind === "REQUEST_WAITING" && row.channel === "IN_APP")?.mutable, false);
    assert.equal(hr.find((row) => row.kind === "REQUEST_WAITING" && row.channel === "PUSH")?.mutable, true);
    const set = (name: string, kind: string, channel: string) =>
      request(http).post("/notifications/preferences").set("Authorization", `Bearer ${as(name).token}`).send({ kind, channel, on: false });
    const notMine = await set("employee", "REQUEST_WAITING", "PUSH");
    assert.equal(notMine.status, 404);
    assert.equal(notMine.body.message, "NOTICE_NOT_FOUND");
    const locked = await set("hr", "REQUEST_WAITING", "IN_APP");
    assert.equal(locked.status, 409);
    assert.equal(locked.body.message, "NOTICE_CHANNEL_LOCKED");
  });

  it("still writes a notice muted in the app, put away, and leaves it out of the bell", async () => {
    const clerk = accounts.find((one) => one.name === "clerk") as Account;
    const muted = await request(http)
      .post("/notifications/preferences")
      .set("Authorization", `Bearer ${clerk.token}`)
      .send({ kind: "ADVANCE_PAID", channel: "IN_APP", on: false });
    assert.equal(muted.status, 201);
    await app.get(NotificationsService).raise(clerk.userId, "ADVANCE_PAID", {});
    const row = await db.notification.findFirst({ where: { userId: clerk.userId, kind: "ADVANCE_PAID" } });
    assert.ok(row, "a muted notice left no row behind");
    assert.notEqual(row.archivedAt, null, "a muted notice was not put away");
    const bell = await request(http).get("/notifications").set("Authorization", `Bearer ${clerk.token}`);
    assert.ok(!(bell.body.rows as { id: string }[]).some((one) => one.id === row.id), "the bell showed a muted notice");
    const counts = await request(http).get("/notifications/counts").set("Authorization", `Bearer ${clerk.token}`);
    assert.equal(counts.body.unread, 0);
  });
});
