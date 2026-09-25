import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { AuthService } from "../src/modules/auth/auth.service.js";
import { hashPassword } from "../src/modules/auth/password.js";
import { paidLeaveType } from "./fixtures.js";
import { clearDeskNotices } from "./teardown.js";

const PASSWORD = "kiosk-e2e-password";
const BOSS = "E2ERQ00";
const ALICE = "E2ERQ01";
const BOB = "E2ERQ02";
const CAROL = "E2ERQ03";
const STAND = "E2ERQ04";
const CODES = [BOSS, ALICE, BOB, CAROL, STAND];
const MAIL = (code: string) => `${code.toLowerCase()}@kiosk.local`;
const PARENT_DEPT = "E2ERQ-P";
const CHILD_DEPT = "E2ERQ-C";
const YEAR = 2041;
const ENTITLED = 12;
const DAY_MS = 86_400_000;

interface Row {
  id: string;
  employeeId: number;
  kind: string;
  state: string;
  waitedDays: number;
  balanceAfter: number | null;
  overlapCount: number | null;
  employee: { code: string; fullName: string; department: { id: string; name: string } | null };
  decidedBy: { fullName: string | null } | null;
}

interface Page {
  rows: Row[];
  total: number;
  totalIsExact: boolean;
  next: string | null;
}

describe("the requests inbox and ledger (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  const token = new Map<string, string>();
  const id = new Map<string, number>();
  let parentId = "";
  let childId = "";
  let aliceLeave = "";
  let bobLeave = "";
  let carolOvertime = "";

  async function sweep(): Promise<void> {
    await clearDeskNotices(db, CODES);
    await db.user.deleteMany({ where: { email: { in: CODES.map(MAIL) } } });
    await db.employee.deleteMany({ where: { code: { in: CODES } } });
    await db.department.deleteMany({ where: { code: CHILD_DEPT } });
    await db.department.deleteMany({ where: { code: PARENT_DEPT } });
  }

  function as(code: string): { get: (path: string) => request.Test; post: (path: string, body: object) => request.Test } {
    const bearer = `Bearer ${token.get(code) ?? ""}`;
    return {
      get: (path) => request(http).get(path).set("Authorization", bearer),
      post: (path, body) => request(http).post(path).set("Authorization", bearer).send(body),
    };
  }

  async function inbox(query = ""): Promise<Page> {
    const res = await as(BOSS).get(`/requests/inbox${query}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body as Page;
  }

  async function file(code: string, body: object): Promise<string> {
    const res = await as(code).post("/requests", { reason: "e2e", ...body });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.id as string;
  }

  before(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    http = app.getHttpServer();
    db = app.get(PrismaService);
    await sweep();

    const entity = await db.legalEntity.findFirstOrThrow();
    parentId = (await db.department.create({ data: { legalEntityId: entity.id, code: PARENT_DEPT, name: "Khối thử" } })).id;
    childId = (
      await db.department.create({ data: { legalEntityId: entity.id, code: CHILD_DEPT, name: "Tổ thử", parentId } })
    ).id;
    const leaveType = await paidLeaveType(db);
    const hash = await hashPassword(PASSWORD);
    const boss = await db.employee.create({ data: { code: BOSS, fullName: "Sếp Thử Hộp", active: true } });
    id.set(BOSS, boss.id);
    const placed: Record<string, string | null> = { [ALICE]: childId, [BOB]: parentId, [CAROL]: null, [STAND]: null };
    for (const code of [ALICE, BOB, CAROL, STAND]) {
      const made = await db.employee.create({
        data: {
          code,
          fullName: `Người ${code}`,
          active: true,
          departmentId: placed[code],
          managerId: code === STAND ? null : boss.id,
        },
      });
      id.set(code, made.id);
      await db.leaveBalance.create({
        data: { employeeId: made.id, leaveTypeId: leaveType.id, year: YEAR, entitled: ENTITLED },
      });
    }
    const auth = app.get(AuthService);
    for (const code of CODES) {
      await db.user.create({
        data: {
          email: MAIL(code),
          passwordHash: hash,
          role: code === BOSS ? "MANAGER" : "EMPLOYEE",
          employeeId: id.get(code),
        },
      });
      token.set(code, (await auth.signIn(MAIL(code), PASSWORD, {})).accessToken);
    }

    aliceLeave = await file(ALICE, {
      kind: "LEAVE",
      leaveTypeId: leaveType.id,
      fromDate: `${YEAR}-03-10`,
      toDate: `${YEAR}-03-12`,
    });
    bobLeave = await file(BOB, {
      kind: "LEAVE",
      leaveTypeId: leaveType.id,
      fromDate: `${YEAR}-03-11`,
      toDate: `${YEAR}-03-11`,
    });
    carolOvertime = await file(CAROL, {
      kind: "OVERTIME",
      fromDate: `${YEAR}-05-01`,
      toDate: `${YEAR}-05-01`,
      fromAt: `${YEAR}-05-01T17:30:00+07:00`,
      toAt: `${YEAR}-05-01T20:00:00+07:00`,
    });
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("puts the oldest first, with who, where and the context to decide", async () => {
    const page = await inbox();
    assert.deepEqual(page.rows.map((row) => row.id), [aliceLeave, bobLeave, carolOvertime]);
    assert.equal(page.total, 3);
    assert.equal(page.totalIsExact, true);
    const alice = page.rows[0];
    assert.equal(alice.employee.code, ALICE);
    assert.equal(alice.employee.department?.id, childId, "the row does not say where the person works");
    assert.equal(alice.waitedDays, 0);
    assert.equal(alice.balanceAfter, ENTITLED - 3, "the balance after granting it is wrong");
    assert.equal(alice.overlapCount, 1, "a teammate off on the same dates was not counted");
    assert.equal(page.rows[1].overlapCount, 1);
    const carol = page.rows[2];
    assert.equal(carol.balanceAfter, null, "overtime has no leave balance");
    assert.equal(carol.overlapCount, null);
  });

  it("works overtime minutes out of the start and end it was filed with", async () => {
    const held = await db.request.findUniqueOrThrow({ where: { id: carolOvertime } });
    assert.equal(held.minutes, 150);
  });

  it("finds a row by the person's code", async () => {
    const page = await inbox(`?search=${BOB.toLowerCase()}`);
    assert.deepEqual(page.rows.map((row) => row.id), [bobLeave]);
    assert.equal(page.total, 1);
  });

  it("narrows to a department and everything under it", async () => {
    const page = await inbox(`?departmentId=${parentId}`);
    assert.deepEqual(page.rows.map((row) => row.id).sort(), [aliceLeave, bobLeave].sort());
    const child = await inbox(`?departmentId=${childId}`);
    assert.deepEqual(child.rows.map((row) => row.id), [aliceLeave]);
  });

  it("keeps a request whose dates touch the range", async () => {
    const page = await inbox(`?from=${YEAR}-03-12&to=${YEAR}-03-20`);
    assert.deepEqual(page.rows.map((row) => row.id), [aliceLeave]);
  });

  it("filters by kind and turns the order around when asked", async () => {
    assert.deepEqual((await inbox("?kind=OVERTIME")).rows.map((row) => row.id), [carolOvertime]);
    assert.equal((await inbox("?order=desc")).rows[0]?.id, carolOvertime);
  });

  it("walks the whole queue a row at a time by cursor, never repeating one", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: Page = await inbox(`?take=1${cursor ? `&cursor=${cursor}` : ""}`);
      assert.equal(page.total, 3, "the total moved while paging");
      seen.push(...page.rows.map((row) => row.id));
      cursor = page.next;
    } while (cursor !== null && seen.length < 10);
    assert.deepEqual(seen, [aliceLeave, bobLeave, carolOvertime]);
  });

  it("counts the same number the list holds, for the badge", async () => {
    const res = await as(BOSS).get("/requests/inbox/counts");
    assert.equal(res.status, 200);
    assert.equal(res.body.requests, 3);
    assert.equal(res.body.advancesToDecide, 0, "a manager was handed the advance queue");
    assert.equal(res.body.disputes, 0);
  });

  it("refuses to turn several down without one reason for them", async () => {
    const res = await as(BOSS).post("/requests/decide-many", { ids: [aliceLeave], approve: false });
    assert.equal(res.status, 400);
    assert.equal(res.body.message, "DECISION_NOTE_REQUIRED");
  });

  it("decides several at once and reports each row it could not", async () => {
    const own = await file(BOSS, { kind: "REMOTE_WORK", fromDate: `${YEAR}-07-01`, toDate: `${YEAR}-07-01` });
    const first = await as(BOSS).post(`/requests/${bobLeave}/decide`, { approve: true });
    assert.equal(first.status, 201);
    const res = await as(BOSS).post("/requests/decide-many", { ids: [aliceLeave, own, bobLeave], approve: true });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.deepEqual(res.body.decided, [aliceLeave]);
    const skipped = new Map((res.body.skipped as { id: string; code: string }[]).map((one) => [one.id, one.code]));
    assert.equal(skipped.get(own), "SELF_DECISION", "the decider's own request went through");
    assert.equal(skipped.get(bobLeave), "REQUEST_ALREADY_DECIDED", "a decided request was decided again");
    const balance = await db.leaveBalance.findFirstOrThrow({ where: { employeeId: id.get(ALICE), year: YEAR } });
    assert.equal(Number(balance.taken), 3);
    assert.equal(Number(balance.pending), 0);
  });

  it("answers a second decision on the same request with the already-decided code", async () => {
    const once = await as(BOSS).post(`/requests/${carolOvertime}/decide`, { approve: true });
    assert.equal(once.status, 201);
    const twice = await as(BOSS).post(`/requests/${carolOvertime}/decide`, { approve: false, note: "e2e" });
    assert.equal(twice.status, 409);
    assert.equal(twice.body.message, "REQUEST_ALREADY_DECIDED");
  });

  it("lets a stand-in decide what their inbox shows them", async () => {
    const today = new Date();
    await db.approvalDelegation.create({
      data: {
        fromId: id.get(BOSS) as number,
        toId: id.get(STAND) as number,
        fromDate: new Date(today.getTime() - DAY_MS),
        toDate: new Date(today.getTime() + DAY_MS),
      },
    });
    const waiting = await db.request.create({
      data: {
        employeeId: id.get(ALICE) as number,
        kind: "REMOTE_WORK",
        state: "PENDING",
        fromDate: new Date(`${YEAR}-06-01`),
        toDate: new Date(`${YEAR}-06-01`),
        reason: "e2e",
        approverId: id.get(BOSS),
      },
    });
    const shown = await as(STAND).get("/requests/inbox");
    assert.equal(shown.status, 200);
    assert.ok((shown.body as Page).rows.some((row) => row.id === waiting.id), "the stand-in's inbox is empty");
    const detail = await as(STAND).get(`/requests/${waiting.id}`);
    assert.equal(detail.status, 200, "the stand-in cannot open what their inbox shows");
    assert.equal(detail.body.mayDecide, true);
    const decided = await as(STAND).post(`/requests/${waiting.id}/decide`, { approve: true });
    assert.equal(decided.status, 201, JSON.stringify(decided.body));
  });

  it("keeps every state in the ledger, with who decided each", async () => {
    const res = await as(BOSS).get(`/requests?departmentId=${parentId}&sort=fromDate&order=asc`);
    assert.equal(res.status, 200);
    const rows = (res.body as Page).rows;
    assert.deepEqual(rows.map((row) => row.id).slice(0, 2), [aliceLeave, bobLeave]);
    assert.ok(rows.every((row) => row.state !== "PENDING" || row.kind !== "LEAVE"));
    assert.equal(rows[0]?.decidedBy?.fullName, "Sếp Thử Hộp", "the ledger does not say who decided");
  });

  it("finds a person's requests in the ledger by name", async () => {
    const res = await as(BOSS).get(`/requests?search=${encodeURIComponent(`Người ${CAROL}`)}`);
    assert.equal(res.status, 200);
    assert.deepEqual((res.body as Page).rows.map((row) => row.id), [carolOvertime]);
  });

  it("exports the ledger under the filter it shows", async () => {
    const res = await as(BOSS).get(`/requests/export?search=${ALICE}`);
    assert.equal(res.status, 200);
    assert.match(String(res.headers["content-type"]), /text\/csv/);
    assert.ok(res.text.includes(ALICE), "the export is missing the row the filter matched");
    assert.ok(!res.text.includes(BOB), "the export ignored the filter");
  });

  it("will not export for somebody who has no ledger", async () => {
    const res = await as(ALICE).get("/requests/export");
    assert.equal(res.status, 403);
  });
});
