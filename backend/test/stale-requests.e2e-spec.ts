import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { StaleRequestsService } from "../src/modules/notifications/stale-requests.service.js";

const FILER = "NV9801";
const APPROVER = "NV9802";
const kDayMs = 86_400_000;

function daysAgo(count: number): Date {
  return new Date(Date.now() - count * kDayMs);
}

describe("stale requests (e2e)", () => {
  let app: INestApplication;
  let db: PrismaService;
  let stale: StaleRequestsService;
  let filerId = 0;
  let approverId = 0;
  const filed: string[] = [];

  async function fileAt(waited: number): Promise<string> {
    const row = await db.request.create({
      data: {
        employeeId: filerId,
        approverId,
        kind: "REMOTE_WORK",
        state: "PENDING",
        fromDate: new Date("2027-03-02"),
        toDate: new Date("2027-03-02"),
        reason: "e2e",
      },
    });
    await db.$executeRaw`
      UPDATE "Request" SET "createdAt" = ${daysAgo(waited)} WHERE "id" = ${row.id}
    `;
    filed.push(row.id);
    return row.id;
  }

  function noticesFor(requestId: string) {
    return db.notification.findMany({ where: { requestId }, orderBy: { kind: "asc" } });
  }

  before(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    db = app.get(PrismaService);
    stale = app.get(StaleRequestsService);
    await db.employee.deleteMany({ where: { code: { in: [FILER, APPROVER] } } });
    const boss = await db.employee.create({ data: { code: APPROVER, fullName: "E2E approver" } });
    approverId = boss.id;
    const person = await db.employee.create({
      data: { code: FILER, fullName: "E2E filer", managerId: boss.id },
    });
    filerId = person.id;
  });

  after(async () => {
    await db.notification.deleteMany({ where: { requestId: { in: filed } } });
    await db.request.deleteMany({ where: { id: { in: filed } } });
    await db.employee.deleteMany({ where: { code: { in: [FILER, APPROVER] } } });
    await app.close();
  });

  it("tells both ends when a request reaches a mark", async () => {
    const id = await fileAt(3);
    await stale.sweep();
    const rows = await noticesFor(id);
    assert.equal(rows.length, 2, "one notice for the filer and one for the approver");
    const filer = rows.find((row) => row.kind === "REQUEST_STALLED");
    const approver = rows.find((row) => row.kind === "REQUEST_WAITING");
    assert.ok(filer && approver, "both kinds were raised");
    assert.equal(filer.employeeId, filerId);
    assert.equal(approver.employeeId, approverId);
    assert.equal(filer.daysWaited, 3);
  });

  it("says a mark once, however often the sweep runs", async () => {
    const id = await fileAt(7);
    await stale.sweep();
    await stale.sweep();
    assert.equal((await noticesFor(id)).length, 2);
  });

  it("stays quiet between marks", async () => {
    const id = await fileAt(5);
    await stale.sweep();
    assert.equal((await noticesFor(id)).length, 0);
  });

  it("stays quiet once somebody has decided", async () => {
    const id = await fileAt(14);
    await db.request.update({ where: { id }, data: { state: "APPROVED" } });
    await stale.sweep();
    assert.equal((await noticesFor(id)).length, 0);
  });
});
