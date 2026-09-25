import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { AuthService } from "../src/modules/auth/auth.service.js";
import { REFRESH_COOKIE } from "../src/modules/auth/auth.types.js";
import { hashPassword, UNUSABLE_PASSWORD } from "../src/modules/auth/password.js";

const PREFIX = "E2EACC";
const DOMAIN = "@e2e-accounts.local";
const PASSWORD = "kiosk-e2e-password";
const SECOND_MS = 1_100;
const PEOPLE = ["BOSS", "STAFF", "DESK", "PAY", "PLAIN", "LEAVER"] as const;

type Person = (typeof PEOPLE)[number];

interface Account {
  id: string;
  email: string;
  role: string;
  active: boolean;
  pending: boolean;
  lastSeenAt: string | null;
  employee: { id: number; code: string; department: { id: string } | null } | null;
}

interface AccountPage {
  rows: Account[];
  total: number;
  next: string | null;
}

function mail(name: string): string {
  return `${name.toLowerCase()}${DOMAIN}`;
}

describe("accounts and roles (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let auth: AuthService;
  let admin = "";
  let adminId = "";
  let root = "";
  let leaf = "";
  const person = {} as Record<Person, number>;
  const account: Record<string, string> = {};

  async function sweep(): Promise<void> {
    await db.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
    await db.employee.updateMany({ where: { code: { startsWith: PREFIX } }, data: { managerId: null } });
    await db.employee.deleteMany({ where: { code: { startsWith: PREFIX } } });
    await db.department.deleteMany({ where: { code: `${PREFIX}-LEAF` } });
    await db.department.deleteMany({ where: { code: `${PREFIX}-ROOT` } });
  }

  function asAdmin(method: "get" | "post" | "patch" | "delete", path: string): request.Test {
    return request(http)[method](path).set("Authorization", `Bearer ${admin}`);
  }

  async function page(query: string): Promise<AccountPage> {
    const res = await asAdmin("get", `/users?${query}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    return res.body as AccountPage;
  }

  async function roleOf(id: string): Promise<string> {
    return (await db.user.findUniqueOrThrow({ where: { id }, select: { role: true } })).role;
  }

  async function withPassword(id: string): Promise<void> {
    await db.user.update({ where: { id }, data: { passwordHash: await hashPassword(PASSWORD) } });
  }

  before(async () => {
    const env = validateEnv();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    http = app.getHttpServer();
    db = app.get(PrismaService);
    auth = app.get(AuthService);
    await sweep();

    const signedIn = await request(http)
      .post("/auth/login")
      .send({ email: "admin@kiosk.local", password: env.SEED_ADMIN_PASSWORD ?? "" });
    assert.equal(signedIn.status, 200, "admin could not sign in");
    admin = signedIn.body.accessToken;
    adminId = (await db.user.findUniqueOrThrow({ where: { email: "admin@kiosk.local" } })).id;

    const entity = await db.legalEntity.findUniqueOrThrow({ where: { code: "DEFAULT" } });
    root = (await db.department.create({ data: { legalEntityId: entity.id, code: `${PREFIX}-ROOT`, name: "Khối thử" } })).id;
    leaf = (
      await db.department.create({
        data: { legalEntityId: entity.id, code: `${PREFIX}-LEAF`, name: "Tổ thử", parentId: root },
      })
    ).id;
    for (const name of PEOPLE) {
      const made = await db.employee.create({
        data: {
          code: `${PREFIX}${name}`,
          fullName: `Người thử ${name}`,
          legalEntityId: entity.id,
          departmentId: leaf,
          personalEmail: mail(name),
          ...(name === "LEAVER" ? { active: false, leaveDate: new Date() } : {}),
        },
      });
      person[name] = made.id;
    }
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("grants each of the six roles, and ties the three that act as a person to a record", async () => {
    const grant = (email: string, role: string, employeeId?: number) =>
      asAdmin("post", "/users").send({ email, role, ...(employeeId === undefined ? {} : { employeeId }) });

    for (const role of ["EMPLOYEE", "MANAGER", "PAYROLL"]) {
      const bare = await grant(mail(`bare-${role}`), role);
      assert.equal(bare.status, 400, `${role} opened with no employee behind it`);
      assert.equal(bare.body.message, "ROLE_NEEDS_EMPLOYEE");
    }
    for (const role of ["ADMIN", "HR", "VIEWER"]) {
      const made = await grant(mail(`free-${role}`), role);
      assert.equal(made.status, 201, JSON.stringify(made.body));
      assert.equal(made.body.role, role);
      assert.equal(made.body.employee, null);
      account[`free-${role}`] = made.body.id;
    }

    const payroll = await grant(mail("PAY"), "PAYROLL", person.PAY);
    assert.equal(payroll.status, 201, JSON.stringify(payroll.body));
    assert.equal(payroll.body.role, "PAYROLL", "payroll could not be granted from the accounts screen");
    assert.equal(payroll.body.employee.id, person.PAY);
    account.PAY = payroll.body.id;

    const asked = await grant(mail("PLAIN"), "MANAGER", person.PLAIN);
    assert.equal(asked.status, 201);
    assert.equal(asked.body.role, "EMPLOYEE", "MANAGER stuck to somebody nobody reports to");
    account.PLAIN = asked.body.id;

    for (const name of ["BOSS", "STAFF"] as const) {
      const made = await grant(mail(name), "EMPLOYEE", person[name]);
      assert.equal(made.status, 201);
      account[name] = made.body.id;
    }
    const desk = await grant(mail("DESK"), "HR", person.DESK);
    assert.equal(desk.status, 201);
    account.DESK = desk.body.id;

    const twice = await grant(mail("second-boss"), "EMPLOYEE", person.BOSS);
    assert.equal(twice.status, 409);
    assert.equal(twice.body.message, "EMPLOYEE_HAS_ACCOUNT");
    const taken = await grant(mail("BOSS"), "VIEWER");
    assert.equal(taken.status, 409);
    assert.equal(taken.body.message, "EMAIL_ALREADY_HAS_ACCOUNT");
    const gone = await grant(mail("LEAVER"), "EMPLOYEE", person.LEAVER);
    assert.equal(gone.status, 409);
    assert.equal(gone.body.message, "EMPLOYEE_HAS_LEFT");
  });

  it("refuses an administrator's own demotion, lock and deletion", async () => {
    for (const body of [{ role: "HR" }, { active: false }]) {
      const res = await asAdmin("patch", `/users/${adminId}`).send(body);
      assert.equal(res.status, 403, `an administrator did ${JSON.stringify(body)} to itself`);
      assert.equal(res.body.message, "SELF_ACCOUNT");
    }
    const erased = await asAdmin("delete", `/users/${adminId}`);
    assert.equal(erased.status, 403);
    assert.equal(await roleOf(adminId), "ADMIN");
  });

  it("locks an account: every session closes, renewal and sign-in fail; unlocking gives the role back", async () => {
    const id = account.BOSS;
    await withPassword(id);
    const held = await auth.signIn(mail("BOSS"), PASSWORD, { userAgent: "e2e-accounts/1.0" });

    const locked = await asAdmin("patch", `/users/${id}`).send({ active: false });
    assert.equal(locked.status, 200, JSON.stringify(locked.body));
    assert.equal(locked.body.active, false);
    assert.equal(await db.session.count({ where: { userId: id, revokedAt: null } }), 0, "a locked account kept a session");
    const me = await request(http).get("/auth/me").set("Authorization", `Bearer ${held.accessToken}`);
    assert.equal(me.status, 401, "a locked account kept using its access token");
    const renewed = await request(http)
      .post("/auth/refresh")
      .set("Cookie", `${REFRESH_COOKIE}=${held.refreshToken}`);
    assert.equal(renewed.status, 401, "a locked account renewed its session");
    await assert.rejects(auth.signIn(mail("BOSS"), PASSWORD, {}), "a locked account signed in");

    const opened = await asAdmin("patch", `/users/${id}`).send({ active: true });
    assert.equal(opened.status, 200);
    assert.equal(opened.body.role, "EMPLOYEE", "unlocking handed back another role");
    await auth.signIn(mail("BOSS"), PASSWORD, { userAgent: "e2e-accounts/1.0" });
  });

  it("will not unlock the account of somebody who has left", async () => {
    const made = await db.user.create({
      data: { email: mail("LEAVER"), passwordHash: UNUSABLE_PASSWORD, role: "EMPLOYEE", active: false, employeeId: person.LEAVER },
    });
    const res = await asAdmin("patch", `/users/${made.id}`).send({ active: true });
    assert.equal(res.status, 409);
    assert.equal(res.body.message, "EMPLOYEE_HAS_LEFT");
    const locked = await asAdmin("patch", `/users/${account["free-VIEWER"]}`).send({ active: false });
    assert.equal(locked.status, 200);
  });

  it("finds an account by email, code or name, and pages through them by email", async () => {
    const mine = await page(`search=${encodeURIComponent(DOMAIN)}&take=200`);
    assert.ok(mine.total >= 9, `only ${mine.total} of this suite's accounts matched`);
    assert.ok(mine.rows.every((row) => row.email.endsWith(DOMAIN)));

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const next: AccountPage = await page(
        `search=${encodeURIComponent(DOMAIN)}&take=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      assert.equal(next.total, mine.total, "the total moved between pages");
      seen.push(...next.rows.map((row) => row.email));
      cursor = next.next;
    } while (cursor);
    assert.deepEqual(seen, mine.rows.map((row) => row.email), "paging dropped or repeated an account");

    const byCode = await page(`search=${PREFIX}PAY`);
    assert.deepEqual(byCode.rows.map((row) => row.id), [account.PAY]);
    const byName = await page(`search=${encodeURIComponent("người thử desk")}`);
    assert.deepEqual(byName.rows.map((row) => row.id), [account.DESK]);
    const boss = mine.rows.find((row) => row.id === account.BOSS);
    assert.ok(boss?.lastSeenAt, "an account that signed in shows no last visit");
  });

  it("filters by role, department branch and status, and counts each value under the other filters", async () => {
    const search = `search=${encodeURIComponent(DOMAIN)}`;
    const payroll = await page(`${search}&role=PAYROLL`);
    assert.deepEqual(payroll.rows.map((row) => row.id), [account.PAY]);

    const branch = await page(`${search}&departmentId=${root}&take=200`);
    assert.ok(branch.rows.some((row) => row.id === account.BOSS), "the branch filter missed a sub-department");
    assert.ok(branch.rows.every((row) => row.employee?.department?.id === leaf));

    const locked = await page(`${search}&status=locked&take=200`);
    assert.ok(locked.rows.every((row) => !row.active));
    assert.ok(locked.rows.some((row) => row.id === account["free-VIEWER"]));
    const pending = await page(`${search}&status=pending&take=200`);
    assert.ok(pending.rows.every((row) => row.active && row.pending));
    assert.ok(!pending.rows.some((row) => row.id === account.BOSS), "an account with a password reads as pending");

    const counts = await asAdmin("get", `/users/counts?${search}&role=PAYROLL`);
    assert.equal(counts.status, 200);
    assert.equal(counts.body.byRole.PAYROLL, 1);
    assert.ok(counts.body.byRole.EMPLOYEE >= 2, "the role facet ignored its own filter being set");
    const all = await page(`${search}&take=200`);
    const { active, locked: closed, pending: waiting } = counts.body.byStatus as Record<string, number>;
    assert.equal(active + closed + waiting, payroll.total, "the status facet dropped the role filter");
    assert.ok(all.total > payroll.total);
  });

  it("tells the signed-in account its own email", async () => {
    const held = await auth.signIn(mail("BOSS"), PASSWORD, { userAgent: "e2e-accounts/1.0" });
    const res = await request(http).get("/users/me").set("Authorization", `Bearer ${held.accessToken}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.email, mail("BOSS"));
    assert.equal(res.body.employee.id, person.BOSS);
  });

  it("deletes an account nobody signed in to, and keeps one with a history", async () => {
    const kept = await asAdmin("delete", `/users/${account.BOSS}`);
    assert.equal(kept.status, 409);
    assert.equal(kept.body.message, "ACCOUNT_HAS_HISTORY");
    const gone = await asAdmin("delete", `/users/${account["free-HR"]}`);
    assert.equal(gone.status, 204);
    assert.equal(await db.user.count({ where: { id: account["free-HR"] } }), 0);
  });

  it("makes somebody MANAGER when a report arrives and EMPLOYEE when it moves away", async () => {
    const waiting = await db.request.create({
      data: {
        employeeId: person.STAFF,
        kind: "LEAVE",
        state: "PENDING",
        fromDate: new Date("2026-12-01"),
        toDate: new Date("2026-12-02"),
        reason: "e2e",
      },
    });
    const held = await auth.signIn(mail("BOSS"), PASSWORD, { userAgent: "e2e-accounts/1.0" });
    // A token from the cutoff's own second is judged by its open session (KEHOACH 9.23), so move on a second.
    await new Promise((settle) => setTimeout(settle, SECOND_MS));

    const under = await asAdmin("patch", `/employees/${person.STAFF}`).send({ managerId: person.BOSS });
    assert.equal(under.status, 200, JSON.stringify(under.body));
    assert.equal(await roleOf(account.BOSS), "MANAGER", "a new manager stayed EMPLOYEE");
    assert.equal(
      (await db.request.findUniqueOrThrow({ where: { id: waiting.id } })).approverId,
      person.BOSS,
      "a pending request stayed with its old approver",
    );
    const stale = await request(http).get("/auth/me").set("Authorization", `Bearer ${held.accessToken}`);
    assert.equal(stale.status, 401, "the token from before the move kept the old role");
    const renewed = await request(http)
      .post("/auth/refresh")
      .set("Cookie", `${REFRESH_COOKIE}=${held.refreshToken}`);
    assert.equal(renewed.status, 200, "the move signed the new manager out");
    const claims = await request(http).get("/auth/me").set("Authorization", `Bearer ${renewed.body.accessToken}`);
    assert.equal(claims.body.role, "MANAGER", "the renewed token does not open the approval inbox");

    const moved = await asAdmin("patch", `/employees/${person.STAFF}`).send({ managerId: person.DESK });
    assert.equal(moved.status, 200);
    assert.equal(await roleOf(account.BOSS), "EMPLOYEE", "a manager with nobody left stayed MANAGER");
    assert.equal(await roleOf(account.DESK), "HR", "the tree touched a role granted by hand");
    assert.equal((await db.request.findUniqueOrThrow({ where: { id: waiting.id } })).approverId, person.DESK);

    const derived = await db.auditLog.findMany({
      where: { subjectType: "user", subjectId: account.BOSS, action: "user.role" },
      orderBy: { id: "asc" },
    });
    assert.deepEqual(
      derived.slice(-2).map((row) => (row.meta as { to: string }).to),
      ["MANAGER", "EMPLOYEE"],
      "a role the tree set left no trace",
    );

    const cleared = await asAdmin("patch", `/employees/${person.STAFF}`).send({ managerId: null });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.managerId, null);
    assert.equal((await db.request.findUniqueOrThrow({ where: { id: waiting.id } })).approverId, null);
  });

  it("returns a manager to EMPLOYEE when their only report leaves", async () => {
    const under = await asAdmin("patch", `/employees/${person.STAFF}`).send({ managerId: person.BOSS });
    assert.equal(under.status, 200);
    assert.equal(await roleOf(account.BOSS), "MANAGER");
    const left = await asAdmin("post", `/employees/${person.STAFF}/offboard`).send({ leaveDate: "2026-12-31" });
    assert.equal(left.status, 201, JSON.stringify(left.body));
    assert.equal(await roleOf(account.BOSS), "EMPLOYEE", "a manager of nobody still working stayed MANAGER");
  });
});
