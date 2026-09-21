import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import type { Env } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";

const FORBIDDEN = 403;

// One account per role. Tokens are signed here rather than asked for: six
// sign-ins would spend the per-minute login allowance every other suite shares.
const WHO = [
  { role: "HR", code: "NV9141R", email: "nv9141r@kiosk.local" },
  { role: "PAYROLL", code: "NV9142R", email: "nv9142r@kiosk.local" },
  { role: "MANAGER", code: "NV9143R", email: "nv9143r@kiosk.local" },
  { role: "EMPLOYEE", code: "NV9144R", email: "nv9144r@kiosk.local" },
  { role: "VIEWER", code: "NV9145R", email: "nv9145r@kiosk.local" },
] as const;

type Who = (typeof WHO)[number]["role"] | "ADMIN";

// What 9.15 and 9.4 say each read is for, and who is left out.
const READS: { path: string; allowed: Who[] }[] = [
  { path: "/devices", allowed: ["ADMIN", "HR"] },
  { path: "/releases", allowed: ["ADMIN"] },
  { path: "/shifts", allowed: ["ADMIN", "HR"] },
  { path: "/holidays?year=2026", allowed: ["ADMIN", "HR"] },
  { path: "/job-titles", allowed: ["ADMIN", "HR"] },
  { path: "/legal-entities", allowed: ["ADMIN", "HR", "PAYROLL"] },
  { path: "/departments", allowed: ["ADMIN", "HR", "PAYROLL", "MANAGER"] },
];

describe("route scope (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let jwt: JwtService;
  let config: ConfigService<Env, true>;
  const tokens = new Map<Who, string>();
  let bossId = 0;
  let underId = 0;

  async function sweep(): Promise<void> {
    await db.user.deleteMany({ where: { email: { in: WHO.map((one) => one.email) } } });
    await db.employee.deleteMany({ where: { code: { in: WHO.map((one) => one.code) } } });
  }

  function tokenFor(userId: string, role: Who, employeeId: number | null): string {
    return jwt.sign(
      { sub: userId, role, sid: "e2e-route-scope", ...(employeeId === null ? {} : { employeeId }) },
      {
        secret: config.get("JWT_ACCESS_SECRET", { infer: true }),
        expiresIn: config.get("JWT_ACCESS_TTL", { infer: true }),
      },
    );
  }

  function get(path: string, who: Who): Promise<request.Response> {
    return request(http).get(path).set("Authorization", `Bearer ${tokens.get(who)}`);
  }

  before(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    http = app.getHttpServer();
    db = app.get(PrismaService);
    jwt = app.get(JwtService);
    config = app.get(ConfigService);
    await sweep();

    const boss = await db.user.findFirstOrThrow({ where: { email: "admin@kiosk.local" } });
    tokens.set("ADMIN", tokenFor(boss.id, "ADMIN", boss.employeeId));

    const template = await db.employee.findFirstOrThrow({ where: { active: true } });
    for (const one of WHO) {
      const made = await db.employee.create({
        data: {
          code: one.code,
          fullName: `Thử phạm vi ${one.code}`,
          departmentId: template.departmentId,
          legalEntityId: template.legalEntityId,
          ...(one.role === "EMPLOYEE" && bossId ? { managerId: bossId } : {}),
        },
      });
      if (one.role === "MANAGER") {
        bossId = made.id;
      }
      if (one.role === "EMPLOYEE") {
        underId = made.id;
      }
      const login = await db.user.create({
        data: { email: one.email, passwordHash: "e2e-never-signs-in", role: one.role, employeeId: made.id },
      });
      tokens.set(one.role, tokenFor(login.id, one.role, made.id));
    }
    await db.employee.update({ where: { id: underId }, data: { managerId: bossId } });
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  for (const read of READS) {
    it(`serves ${read.path} to ${read.allowed.join(", ")} and nobody else`, async () => {
      for (const who of ["ADMIN", ...WHO.map((one) => one.role)] as Who[]) {
        const res = await get(read.path, who);
        if (read.allowed.includes(who)) {
          assert.notEqual(res.status, FORBIDDEN, `${who} was refused ${read.path}`);
        } else {
          assert.equal(res.status, FORBIDDEN, `${who} was served ${read.path}`);
        }
      }
    });
  }

  it("keeps a manager's attendance report inside their own subtree", async () => {
    const span = "from=2026-01-01&to=2026-12-31";
    const wide = await get(`/reports/attendance?${span}`, "ADMIN");
    assert.equal(wide.status, 200, JSON.stringify(wide.body));
    const narrow = await get(`/reports/attendance?${span}`, "MANAGER");
    assert.equal(narrow.status, 200, JSON.stringify(narrow.body));

    const seen = (narrow.body as { employeeId: number }[]).map((row) => row.employeeId);
    const outside = seen.filter((id) => id !== bossId && id !== underId);
    assert.deepEqual(outside, [], "the manager was shown people outside their own tree");
    assert.ok(
      (wide.body as unknown[]).length >= (narrow.body as unknown[]).length,
      "narrowing gave the manager more than the admin",
    );
  });

  it("keeps the report an admin reads out of the manager's cache entry", async () => {
    const span = "from=2026-02-01&to=2026-02-28";
    // The manager asks first, so a shared key would hold the narrow answer.
    await get(`/reports/attendance?${span}`, "MANAGER");
    const wide = await get(`/reports/attendance?${span}`, "ADMIN");
    assert.equal(wide.status, 200);
    const again = await get(`/reports/attendance?${span}`, "MANAGER");
    assert.equal(again.status, 200);
    assert.ok(
      (wide.body as unknown[]).length >= (again.body as unknown[]).length,
      "the manager's narrow answer was served to the admin",
    );
  });

  it("refuses an employee the whole company's attendance", async () => {
    const res = await get("/reports/attendance?from=2026-01-01&to=2026-12-31", "EMPLOYEE");
    assert.equal(res.status, FORBIDDEN);
  });

  it("drops only the caller's own push subscription", async () => {
    const endpoint = "https://push.example.com/e2e-route-scope";
    const mine = await db.employee.findFirstOrThrow({ where: { code: "NV9144R" } });
    await db.pushSubscription.deleteMany({ where: { endpoint } });
    await db.pushSubscription.create({
      data: { employeeId: mine.id, endpoint, p256dh: "k", auth: "a" },
    });

    const stranger = await request(http)
      .delete(`/notifications/subscribe?endpoint=${encodeURIComponent(endpoint)}`)
      .set("Authorization", `Bearer ${tokens.get("MANAGER")}`);
    assert.equal(stranger.status, 200);
    assert.equal(
      await db.pushSubscription.count({ where: { endpoint } }),
      1,
      "somebody else's device was unsubscribed by naming its endpoint",
    );

    const owner = await request(http)
      .delete(`/notifications/subscribe?endpoint=${encodeURIComponent(endpoint)}`)
      .set("Authorization", `Bearer ${tokens.get("EMPLOYEE")}`);
    assert.equal(owner.status, 200);
    assert.equal(await db.pushSubscription.count({ where: { endpoint } }), 0);
  });
});
