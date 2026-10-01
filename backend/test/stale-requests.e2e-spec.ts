import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { NoticeItemsService } from "../src/modules/notifications/notice-items.service.js";
import { StalledSweep } from "../src/modules/notifications/sweeps/stalled.sweep.js";

const FILER = "NV9801";
const APPROVER = "NV9802";
const kDayMs = 86_400_000;
const UNREACHABLE = "none$";

function daysAgo(count: number): Date {
  return new Date(Date.now() - count * kDayMs);
}

describe("stale requests (e2e)", () => {
  let app: INestApplication;
  let db: PrismaService;
  let stale: StalledSweep;
  let items: NoticeItemsService;
  let filerId = 0;
  let approverId = 0;
  let filerLogin = "";
  let approverLogin = "";
  const filed: string[] = [];

  async function age(id: string, waited: number): Promise<void> {
    await db.$executeRaw`UPDATE "Request" SET "createdAt" = ${daysAgo(waited)} WHERE "id" = ${id}`;
  }

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
    await age(row.id, waited);
    await items.open("REQUESTS", { id: row.id, employeeId: filerId });
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
    stale = app.get(StalledSweep);
    items = app.get(NoticeItemsService);
    await db.user.deleteMany({ where: { email: { in: [`${FILER}@kiosk.local`, `${APPROVER}@kiosk.local`] } } });
    await db.employee.deleteMany({ where: { code: { in: [FILER, APPROVER] } } });
    const boss = await db.employee.create({ data: { code: APPROVER, fullName: "E2E approver" } });
    approverId = boss.id;
    const person = await db.employee.create({
      data: { code: FILER, fullName: "E2E filer", managerId: boss.id },
    });
    filerId = person.id;
    // A notice is addressed to a login, so somebody with none hears nothing.
    approverLogin = (
      await db.user.create({
        data: { email: `${APPROVER}@kiosk.local`, passwordHash: UNREACHABLE, role: "MANAGER", employeeId: approverId },
      })
    ).id;
    filerLogin = (
      await db.user.create({
        data: { email: `${FILER}@kiosk.local`, passwordHash: UNREACHABLE, role: "EMPLOYEE", employeeId: filerId },
      })
    ).id;
  });

  after(async () => {
    await db.notification.deleteMany({ where: { requestId: { in: filed } } });
    await db.request.deleteMany({ where: { id: { in: filed } } });
    await db.user.deleteMany({ where: { email: { in: [`${FILER}@kiosk.local`, `${APPROVER}@kiosk.local`] } } });
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
    assert.equal(filer.userId, filerLogin);
    assert.equal(approver.userId, approverLogin);
    assert.equal(filer.daysWaited, 3);
  });

  it("says a mark once, however often the sweep runs", async () => {
    const id = await fileAt(7);
    await stale.sweep();
    const once = await noticesFor(id);
    await stale.sweep();
    assert.equal((await noticesFor(id)).length, once.length, "a second sweep spoke again");
    assert.equal(once.filter((row) => row.kind === "REQUEST_STALLED").length, 1, "the asker heard the mark other than once");
    // From day seven the desk joins the manager's group (KEHOACH 9.21.4).
    assert.ok(once.some((row) => row.kind === "REQUEST_WAITING" && row.userId === approverLogin), "the approver was not reminded");
  });

  it("stays quiet between marks", async () => {
    const id = await fileAt(3);
    await stale.sweep();
    await age(id, 5);
    await stale.sweep();
    const stalled = (await noticesFor(id)).filter((row) => row.kind === "REQUEST_STALLED");
    assert.equal(stalled.length, 1);
    assert.equal(stalled[0].remindCount, 0, "a day between marks spoke");
  });

  it("says a missed mark once, a day late", async () => {
    const id = await fileAt(4);
    await stale.sweep();
    await stale.sweep();
    const stalled = (await noticesFor(id)).filter((row) => row.kind === "REQUEST_STALLED");
    assert.equal(stalled.length, 1, "a mark the sweep missed was never said");
    assert.equal(stalled[0].remindCount, 0, "a mark caught up was said twice");
    assert.equal(stalled[0].daysWaited, 4);
  });

  it("speaks again on one row at the next mark", async () => {
    const id = await fileAt(3);
    await stale.sweep();
    await db.notification.updateMany({ where: { requestId: id }, data: { readAt: new Date() } });
    await age(id, 7);
    await stale.sweep();
    const rows = await noticesFor(id);
    const stalled = rows.filter((row) => row.kind === "REQUEST_STALLED");
    assert.equal(stalled.length, 1, "the next mark wrote a second row");
    assert.equal(stalled[0].remindCount, 1);
    assert.equal(stalled[0].readAt, null, "the next mark left the asker's row read");
    const approver = rows.find((row) => row.kind === "REQUEST_WAITING" && row.userId === approverLogin);
    assert.equal(approver?.readAt, null, "the approver was not reminded");
  });

  it("stays quiet once somebody has decided", async () => {
    const id = await fileAt(14);
    await db.request.update({ where: { id }, data: { state: "APPROVED" } });
    await stale.sweep();
    const rows = await noticesFor(id);
    assert.equal(rows.filter((row) => row.kind === "REQUEST_STALLED").length, 0);
    assert.ok(rows.every((row) => row.remindCount === 0), "a decided request was nudged");
  });
});
