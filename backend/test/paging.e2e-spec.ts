import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { COUNT_CEILING, MAX_OFFSET } from "../src/common/dto/cursor.dto.js";

const TAKE = 20;
const DEVICE = "e2e-paging-door";
const CODE = "E2EPG01";
const MADE_PUNCHES = 5;
const PERSON = "Người bị phân trang";

interface Punch {
  id: string;
  ts: string;
}

interface Answer {
  rows: Punch[];
  total: number;
  totalIsExact: boolean;
  next: string | null;
}

describe("paging (e2e)", () => {
  let app: INestApplication;
  let http: ReturnType<INestApplication["getHttpServer"]>;
  let db: PrismaService;
  let token = "";
  let employeeId = 0;
  let shared: Date;

  async function sweep(): Promise<void> {
    await db.attendanceRecord.deleteMany({ where: { deviceId: DEVICE } });
    await db.employee.deleteMany({ where: { code: CODE } });
    await db.device.deleteMany({ where: { id: DEVICE } });
  }

  async function punches(query: string): Promise<Answer> {
    const res = await request(http)
      .get(`/attendance?${query}`)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200, `GET /attendance?${query}`);
    return res.body as Answer;
  }

  before(async () => {
    const env = validateEnv();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    http = app.getHttpServer();
    db = app.get(PrismaService);
    await sweep();

    const signedIn = await request(http)
      .post("/auth/login")
      .send({ email: "admin@kiosk.local", password: env.SEED_ADMIN_PASSWORD ?? "" });
    assert.equal(signedIn.status, 200, "admin could not sign in");
    token = signedIn.body.accessToken;

    await db.device.create({ data: { id: DEVICE, name: DEVICE, status: "APPROVED" } });
    const made = await db.employee.create({
      data: { code: CODE, fullName: PERSON, active: true },
    });
    employeeId = made.id;

    // Every punch on one timestamp: ts alone leaves them in no defined order.
    shared = new Date("2026-03-01T01:00:00.000Z");
    await db.attendanceRecord.createMany({
      data: Array.from({ length: MADE_PUNCHES }, (unused, at) => ({
        localId: `E2EPG-${at}`,
        employeeId,
        deviceId: DEVICE,
        ts: shared,
        direction: "IN",
        score: 0.9,
      })),
    });
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("refuses an offset deep enough to make Postgres count and discard", async () => {
    const res = await request(http)
      .get(`/attendance?skip=${MAX_OFFSET + 1}`)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 400, "a bottomless offset was accepted");
  });

  it("refuses a cursor nobody issued", async () => {
    const res = await request(http)
      .get("/attendance?cursor=not-a-cursor")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 400);
    assert.equal(res.body.message, "CURSOR_INVALID");
  });

  it("hands back a cursor while there is more, and null at the end", async () => {
    const page = await punches(`employeeId=${employeeId}&take=2`);
    assert.equal(page.rows.length, 2);
    assert.ok(page.next, "a full page did not say how to continue");

    const last = await punches(`employeeId=${employeeId}&take=${MADE_PUNCHES + 1}`);
    assert.equal(last.rows.length, MADE_PUNCHES);
    assert.equal(last.next, null, "a short page still offered a next cursor");
  });

  it("walks every punch once although they share one timestamp", async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MADE_PUNCHES + 2; page += 1) {
      const query = `employeeId=${employeeId}&take=2${cursor ? `&cursor=${cursor}` : ""}`;
      const answer: Answer = await punches(query);
      seen.push(...answer.rows.map((row) => row.id));
      cursor = answer.next;
      if (!cursor) {
        break;
      }
    }
    assert.equal(seen.length, MADE_PUNCHES, "paging returned a different number of punches");
    assert.equal(new Set(seen).size, MADE_PUNCHES, "one punch came back on two pages");
  });

  it("does not repeat a row when a punch lands between two pages", async () => {
    const first = await punches(`employeeId=${employeeId}&take=2`);
    const arriving = await db.attendanceRecord.create({
      data: {
        localId: "E2EPG-LATE",
        employeeId,
        deviceId: DEVICE,
        ts: new Date(shared.getTime() + 60_000),
        direction: "IN",
        score: 0.9,
      },
    });

    const byCursor = await punches(`employeeId=${employeeId}&take=2&cursor=${first.next ?? ""}`);
    const held = new Set(first.rows.map((row) => row.id));
    const repeatedByCursor = byCursor.rows.filter((row) => held.has(row.id)).length;

    const byOffset = await punches(`employeeId=${employeeId}&take=2&skip=2`);
    const repeatedByOffset = byOffset.rows.filter((row) => held.has(row.id)).length;

    assert.equal(repeatedByCursor, 0, "the cursor repeated a row across a write");
    assert.equal(repeatedByOffset, 1, "the offset drift this rule exists for has gone away");
    await db.attendanceRecord.delete({ where: { id: arriving.id } });
  });

  it("counts a short list exactly", async () => {
    const page = await punches(`employeeId=${employeeId}&take=2`);
    assert.equal(page.total, MADE_PUNCHES);
    assert.equal(page.totalIsExact, true, "a list well under the ceiling was called approximate");
  });

  it("stops counting at the ceiling and says the total is a floor", async () => {
    const page = await punches("take=2");
    assert.equal(page.total, COUNT_CEILING, "a list past the ceiling reported an exact total");
    assert.equal(page.totalIsExact, false);
  });

  it("stops the count at the ceiling instead of reaching the end", async () => {
    const held = await db.attendanceRecord.count();
    assert.ok(held > COUNT_CEILING, "this case needs more punches than the ceiling");
    const bounded = await db.attendanceRecord.count({ take: COUNT_CEILING + 1 });
    assert.equal(bounded, COUNT_CEILING + 1, "take no longer bounds a count, so every page counts the table");
  });

  it("pages the employee list by code as well", async () => {
    const res = await request(http)
      .get("/employees?take=3")
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200);
    const first = res.body as { rows: { code: string }[]; next: string | null };
    assert.equal(first.rows.length, 3);
    assert.ok(first.next);

    const more = await request(http)
      .get(`/employees?take=3&cursor=${first.next ?? ""}`)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(more.status, 200);
    const second = more.body as { rows: { code: string }[] };
    const held = new Set(first.rows.map((row) => row.code));
    assert.equal(
      second.rows.filter((row) => held.has(row.code)).length,
      0,
      "the second page repeats somebody from the first",
    );
    assert.ok(
      (second.rows[0]?.code ?? "") > (first.rows[2]?.code ?? ""),
      "the list did not carry on where it stopped",
    );
  });

  it("pages the attendance roll-up by name and carries on where it stopped", async () => {
    const span = "from=2020-01-01T00:00:00.000Z&to=2099-01-01T00:00:00.000Z";
    const res = await request(http)
      .get(`/reports/attendance?${span}&take=2`)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const first = res.body as { rows: { fullName: string }[]; total: number; next: string | null };
    assert.ok(first.total >= 1, "the roll-up covered nobody");
    if (first.next === null) {
      return;
    }
    const more = await request(http)
      .get(`/reports/attendance?${span}&take=2&cursor=${first.next}`)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(more.status, 200);
    const second = more.body as { rows: { fullName: string }[] };
    const held = new Set(first.rows.map((row) => row.fullName));
    assert.equal(
      second.rows.filter((row) => held.has(row.fullName)).length,
      0,
      "the second page of the roll-up repeats a name from the first",
    );
  });

  it("narrows the roll-up to the name asked for", async () => {
    const span = "from=2020-01-01T00:00:00.000Z&to=2099-01-01T00:00:00.000Z";
    const res = await request(http)
      .get(`/reports/attendance?${span}&search=${encodeURIComponent(PERSON)}`)
      .set("Authorization", `Bearer ${token}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const page = res.body as { rows: { fullName: string }[]; total: number };
    assert.equal(page.total, page.rows.length, "a filtered total disagreed with its own page");
    assert.equal(
      page.rows.filter((row) => !row.fullName.includes(PERSON)).length,
      0,
      "the filter let somebody else through",
    );
  });
});
