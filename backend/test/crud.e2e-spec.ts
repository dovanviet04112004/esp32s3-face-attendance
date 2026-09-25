import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";

const MADE_CODES = ["NV9001", "NV9002", "NV9003"];
const MADE_SHIFTS = ["Ca chiều", "Ca hỏng"];

const ACCOUNTS = {
  admin: "admin@kiosk.local",
  hr: "hr@kiosk.local",
  viewer: "viewer@kiosk.local",
};

const WAITING = "kiosk-e2e-waiting";
const CLAIM = "104729";

describe("crud (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  const token: Record<keyof typeof ACCOUNTS, string> = { admin: "", hr: "", viewer: "" };
  let madeEmployeeId = 0;
  let madeShiftId = "";
  let db: PrismaService;

  // The suite writes real rows, so it clears its own at each end of the run.
  async function sweep(): Promise<void> {
    await db.device.deleteMany({ where: { id: WAITING } });
    await db.shiftAssignment.deleteMany({ where: { shift: { name: { in: MADE_SHIFTS } } } });
    await db.shift.deleteMany({ where: { name: { in: MADE_SHIFTS } } });
    await db.employee.deleteMany({ where: { code: { in: MADE_CODES } } });
  }

  before(async () => {
    const password = validateEnv().SEED_ADMIN_PASSWORD ?? "";
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    http = app.getHttpServer();
    db = app.get(PrismaService);
    await sweep();
    const asked = await request(http).post("/devices/register").send({
      deviceId: WAITING,
      bootstrapToken: validateEnv().DEVICE_BOOTSTRAP_TOKEN,
      claimCode: CLAIM,
    });
    assert.equal(asked.status, 202, "the waiting kiosk could not register");
    for (const [role, email] of Object.entries(ACCOUNTS)) {
      const res = await request(http).post("/auth/login").send({ email, password });
      assert.equal(res.status, 200, `${role} could not sign in`);
      token[role as keyof typeof ACCOUNTS] = res.body.accessToken;
    }
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  // The default role reads the route and gets its own rows, which for an
  // account with no employee record is none (KEHOACH 9.4).
  it("lets a viewer read employees, and hands them nobody", async () => {
    const res = await request(http)
      .get("/employees")
      .set("Authorization", `Bearer ${token.viewer}`);
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.rows));
    assert.equal(res.body.total, 0);
  });

  it("refuses a viewer trying to create an employee", async () => {
    const res = await request(http)
      .post("/employees")
      .set("Authorization", `Bearer ${token.viewer}`)
      .send({ code: "NV9001", fullName: "Không được tạo" });
    assert.equal(res.status, 403);
  });

  it("lets hr create an employee and gives it a server-side id", async () => {
    const res = await request(http)
      .post("/employees")
      .set("Authorization", `Bearer ${token.hr}`)
      .send({ code: "NV9002", fullName: "Lê Văn C" });
    assert.equal(res.status, 201);
    assert.ok(Number.isInteger(res.body.id));
    madeEmployeeId = res.body.id;
  });

  it("refuses a second employee with the same code", async () => {
    const res = await request(http)
      .post("/employees")
      .set("Authorization", `Bearer ${token.hr}`)
      .send({ code: "NV9002", fullName: "Trùng mã" });
    assert.equal(res.status, 409);
  });

  it("refuses a field the contract never declared", async () => {
    const res = await request(http)
      .post("/employees")
      .set("Authorization", `Bearer ${token.hr}`)
      .send({ code: "NV9003", fullName: "Thừa trường", isAdmin: true });
    assert.equal(res.status, 400);
  });

  it("retires an employee rather than erasing the row", async () => {
    const res = await request(http)
      .delete(`/employees/${madeEmployeeId}`)
      .set("Authorization", `Bearer ${token.hr}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.active, false);

    const still = await request(http)
      .get(`/employees/${madeEmployeeId}`)
      .set("Authorization", `Bearer ${token.hr}`);
    assert.equal(still.status, 200);
  });

  it("filters the directory by whether people still work here", async () => {
    const read = (active: string) =>
      request(http)
        .get(`/employees?search=NV9002&active=${active}`)
        .set("Authorization", `Bearer ${token.hr}`);
    const left = await read("false");
    assert.equal(left.status, 200);
    assert.deepEqual(
      left.body.rows.map((row: { code: string }) => row.code),
      ["NV9002"],
    );
    const working = await read("true");
    assert.equal(working.status, 200);
    assert.equal(working.body.rows.length, 0, "a retired employee is still listed as working");
  });

  it("refuses hr on a device, which only an admin may accept", async () => {
    const res = await request(http)
      .post(`/devices/${WAITING}/approve`)
      .set("Authorization", `Bearer ${token.hr}`)
      .send({ name: "Cửa trước" });
    assert.equal(res.status, 403);
  });

  it("lets an admin accept a device that was waiting", async () => {
    const res = await request(http)
      .post(`/devices/${WAITING}/approve`)
      .set("Authorization", `Bearer ${token.admin}`)
      .send({ name: "Cửa trước", location: "Tầng 1", claimCode: CLAIM });
    assert.equal(res.status, 201);
    assert.equal(res.body.status, "APPROVED");
    assert.equal(res.body.name, "Cửa trước");
    assert.ok(res.body.approvedAt);
  });

  it("answers 404 for a device nobody has seen", async () => {
    const res = await request(http)
      .get("/devices/kiosk-does-not-exist")
      .set("Authorization", `Bearer ${token.admin}`);
    assert.equal(res.status, 404);
  });

  it("creates a shift and refuses a clock that is not HH:MM", async () => {
    const good = await request(http)
      .post("/shifts")
      .set("Authorization", `Bearer ${token.hr}`)
      .send({ name: "Ca chiều", startTime: "13:00", endTime: "21:30", graceMinutes: 5 });
    assert.equal(good.status, 201);
    madeShiftId = good.body.id;

    const bad = await request(http)
      .post("/shifts")
      .set("Authorization", `Bearer ${token.hr}`)
      .send({ name: "Ca hỏng", startTime: "25:00", endTime: "21:30" });
    assert.equal(bad.status, 400);
  });

  it("assigns an employee to a shift and refuses an employee who does not exist", async () => {
    const ok = await request(http)
      .post(`/shifts/${madeShiftId}/assignments`)
      .set("Authorization", `Bearer ${token.hr}`)
      .send({ employeeId: 1, validFrom: "2026-02-01T00:00:00.000Z" });
    assert.equal(ok.status, 201);

    const ghost = await request(http)
      .post(`/shifts/${madeShiftId}/assignments`)
      .set("Authorization", `Bearer ${token.hr}`)
      .send({ employeeId: 999999, validFrom: "2026-02-01T00:00:00.000Z" });
    assert.equal(ghost.status, 404);
  });

  it("caps a page size so one request cannot ask for the whole table", async () => {
    const res = await request(http)
      .get("/employees?take=5000")
      .set("Authorization", `Bearer ${token.viewer}`);
    assert.equal(res.status, 400);
  });

  it("serves the swagger document with every tag", async () => {
    const res = await request(http).get("/docs-json");
    assert.equal(res.status, 200);
    const tags = Object.values(res.body.paths as Record<string, Record<string, { tags: string[] }>>)
      .flatMap((methods) => Object.values(methods))
      .flatMap((operation) => operation.tags ?? []);
    for (const wanted of ["auth", "employees", "devices", "shifts"]) {
      assert.ok(tags.includes(wanted), `swagger is missing the ${wanted} tag`);
    }
  });
});
