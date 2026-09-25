import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { Prisma } from "@prisma/client";
import request from "supertest";

import { AppModule } from "../src/app.module.js";
import { configure } from "../src/bootstrap.js";
import type { AttendanceRecord } from "../src/common/generated/attendance_record.js";
import type { Heartbeat } from "../src/common/generated/heartbeat.js";
import { validateEnv } from "../src/config/env.schema.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { AttendanceService } from "../src/modules/attendance/attendance.service.js";
import { EnrollmentListener } from "../src/modules/enrollment/enrollment.listener.js";
import type { KioskMessage } from "../src/modules/mqtt/mqtt.events.js";
import { ContractAlertsService } from "../src/modules/notifications/contract-alerts.service.js";
import { StaleRequestsService } from "../src/modules/notifications/stale-requests.service.js";
import { ReportsService } from "../src/modules/reports/reports.service.js";
import { dayWindow, localDateSql, localDay } from "../src/modules/timesheet/local-day.js";
import { TimesheetService } from "../src/modules/timesheet/timesheet.service.js";
import { QUEUE_TOKEN, type Queues } from "../src/queue/queue.module.js";
import { QUEUE } from "../src/queue/queues.js";

const DOUBTED = "NV9831";
const LATE = "NV9832";
const NIGHTLY = "NV9833";
const WAITER = "NV9834";
const BOSS = "NV9835";
const ENDING_29 = "NV9836";
const ENDING_30 = "NV9837";
const CODES = [DOUBTED, LATE, NIGHTLY, WAITER, BOSS, ENDING_29, ENDING_30];
const MAIL = (code: string) => `${code.toLowerCase()}@kiosk.local`;
const UNREACHABLE = "none$";
const DEVICE = "e2e-clock-01";
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
// Finished weekdays inside the partition range that no other suite builds.
const FUTURE_DAY = "2026-04-15";
const LATE_DAY = "2026-04-14";
// 00:30 on 14 March 2031 in Vietnam is still the 13th in UTC; far from the clock every other suite reads.
const HALF_PAST_MIDNIGHT = new Date("2031-03-13T17:30:00.000Z");

describe("company time (e2e)", () => {
  let app: INestApplication;
  let db: PrismaService;
  let attendance: AttendanceService;
  let timesheet: TimesheetService;
  let queues: Queues;
  let zone = "";
  let adminToken = "";
  let localSeq = 0;
  const idOf = new Map<string, number>();
  const filed: string[] = [];

  function atLocal(day: string, hours: number): Date {
    return new Date(dayWindow(day, zone).from.getTime() + hours * HOUR_MS);
  }

  function punch(code: string, ts: number): AttendanceRecord {
    localSeq += 1;
    return {
      deviceId: DEVICE,
      localId: String(9_830_000 + localSeq),
      employeeId: idOf.get(code) as number,
      ts,
      direction: "IN",
      matchScore: 0.9,
      livenessScore: 0.9,
      modelVersion: 1,
    };
  }

  function dayRow(code: string, day: string) {
    return db.attendanceDay.findFirst({ where: { employeeId: idOf.get(code), date: new Date(`${day}T00:00:00.000Z`) } });
  }

  async function sweep(): Promise<void> {
    await db.notification.deleteMany({ where: { requestId: { in: filed } } });
    await db.request.deleteMany({ where: { id: { in: filed } } });
    await db.attendanceRecord.deleteMany({ where: { deviceId: DEVICE } });
    await db.user.deleteMany({ where: { email: { in: CODES.map(MAIL) } } });
    await db.employee.deleteMany({ where: { code: { in: CODES } } });
    await db.device.deleteMany({ where: { id: DEVICE } });
  }

  before(async () => {
    const env = validateEnv();
    zone = env.APP_TIMEZONE;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    configure(app);
    await app.init();
    db = app.get(PrismaService);
    attendance = app.get(AttendanceService);
    timesheet = app.get(TimesheetService);
    queues = app.get<Queues>(QUEUE_TOKEN);
    await sweep();

    const signedIn = await request(app.getHttpServer())
      .post("/auth/login")
      .send({ email: "admin@kiosk.local", password: env.SEED_ADMIN_PASSWORD ?? "" });
    assert.equal(signedIn.status, 200, "admin could not sign in");
    adminToken = signedIn.body.accessToken;

    await db.device.create({ data: { id: DEVICE, status: "APPROVED" } });
    for (const code of CODES) {
      const made = await db.employee.create({
        data: {
          code,
          fullName: `Giờ công ty ${code}`,
          active: true,
          login: { create: { email: MAIL(code), passwordHash: UNREACHABLE, role: "EMPLOYEE" } },
        },
      });
      idOf.set(code, made.id);
    }
  });

  after(async () => {
    await sweep();
    await app.close();
  });

  it("files a 1970 punch and one a week ahead as questionable, and neither lands in a day", async () => {
    const heard = new Date();
    assert.equal(await attendance.record(punch(DOUBTED, 5_000), heard), "stored");
    const ahead = atLocal(FUTURE_DAY, 9);
    assert.equal(await attendance.record(punch(DOUBTED, ahead.getTime()), new Date(ahead.getTime() - 7 * DAY_MS)), "stored");

    const rows = await db.attendanceRecord.findMany({ where: { employeeId: idOf.get(DOUBTED) }, orderBy: { ts: "asc" } });
    assert.deepEqual(rows.map((row) => row.questionableTime), [true, true]);
    assert.equal(rows[0]?.receivedAt?.getTime(), heard.getTime(), "the receipt time was not kept");

    await timesheet.build(FUTURE_DAY, idOf.get(DOUBTED));
    const built = await dayRow(DOUBTED, FUTURE_DAY);
    assert.equal(built?.punchCount, 0, "a questionable punch was counted into the day its own clock names");
    assert.equal(built?.state, "ABSENT");
    assert.equal(
      await queues[QUEUE.timesheet].getDeduplicationJobId(`rebuild-${idOf.get(DOUBTED)}-1970-01-01`),
      null,
      "a questionable punch queued a rebuild",
    );
  });

  it("hands today's questionable punch to HR with its receipt time, and the lists mark it", async () => {
    const reports = app.get(ReportsService);
    const page = await reports.exceptionsPage("NV9830", 5);
    const mine = page.rows.find((row) => row.employeeId === idOf.get(DOUBTED));
    assert.equal(mine?.reason, "QUESTIONABLE_TIME", JSON.stringify(page.rows));
    assert.ok(mine?.receivedAt, "the exception carries no receipt time");

    const { from, to } = dayWindow(localDay(new Date(), zone), zone);
    const range = `employeeId=${idOf.get(DOUBTED)}&from=${from.toISOString()}&to=${to.toISOString()}`;
    const listed = await request(app.getHttpServer())
      .get(`/attendance?${range}&questionableTime=true`)
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.equal(listed.body.rows.length, 1, "the flag filter reads today as arrival, not as the punch's own time");
    assert.equal(listed.body.rows[0].questionableTime, true);
    const counted = await request(app.getHttpServer())
      .get(`/attendance/counts?${range}`)
      .set("Authorization", `Bearer ${adminToken}`);
    assert.equal(counted.body.questionableTime, 1);
    assert.equal(counted.body.all, 0, "a 1970 punch counted as one taken today");
  });

  it("rebuilds a finished day when a punch for it arrives after the build", async () => {
    await timesheet.build(LATE_DAY, idOf.get(LATE));
    assert.equal((await dayRow(LATE, LATE_DAY))?.state, "ABSENT");

    assert.equal(await attendance.record(punch(LATE, atLocal(LATE_DAY, 8).getTime()), new Date()), "stored");
    let row = await dayRow(LATE, LATE_DAY);
    for (let waited = 0; row?.punchCount !== 1 && waited < 40; waited += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      row = await dayRow(LATE, LATE_DAY);
    }
    assert.equal(row?.punchCount, 1, "the late punch never reached its day");
    assert.equal(row?.state, "WORKED");
  });

  it("builds yesterday at 00:30 company time, and a second run changes nothing", async () => {
    const scheduler = await queues[QUEUE.timesheet].getJobScheduler("timesheet-nightly");
    assert.equal(scheduler?.pattern, "30 0 * * *");
    assert.equal(scheduler?.tz, zone);

    const yesterday = timesheet.yesterday();
    await db.attendanceRecord.createMany({
      data: [8, 17].map((hours) => {
        const at = atLocal(yesterday, hours);
        localSeq += 1;
        return {
          deviceId: DEVICE,
          localId: String(9_830_000 + localSeq),
          employeeId: idOf.get(NIGHTLY) as number,
          ts: at,
          receivedAt: at,
          direction: "IN",
        };
      }),
    });
    await timesheet.runJob({ type: "nightly" });
    const first = await dayRow(NIGHTLY, yesterday);
    assert.equal(first?.punchCount, 2);
    assert.equal(first?.workedMinutes, 9 * 60);

    await timesheet.runJob({ type: "nightly" });
    const second = await dayRow(NIGHTLY, yesterday);
    assert.deepEqual(second, first, "a second nightly run rewrote a day it had already built");
  });

  it("repeats every scheduled job in the company's zone", async () => {
    const seen: string[] = [];
    for (const queue of Object.values(queues)) {
      for (const one of await queue.getJobSchedulers()) {
        seen.push(one.key);
        assert.equal(one.tz, zone, `${queue.name}/${one.key} repeats in UTC`);
      }
    }
    for (const key of ["requests-stale-daily", "contracts-ending-daily", "timesheet-nightly", "leave-year-open"]) {
      assert.ok(seen.includes(key), `${key} is not scheduled`);
    }
  });

  it("reads 00:30 in Vietnam as the new day, in code and in SQL", async () => {
    assert.equal(localDay(HALF_PAST_MIDNIGHT, zone), "2031-03-14");
    const [row] = await db.$queryRaw<{ local: string; utc: string }[]>`
      SELECT ${localDateSql(Prisma.sql`${HALF_PAST_MIDNIGHT}::timestamp`, zone)}::text AS "local",
             (${HALF_PAST_MIDNIGHT}::timestamp)::date::text AS "utc"
    `;
    assert.equal(row?.local, "2031-03-14");
    assert.equal(row?.utc, "2031-03-13", "the helper agrees with a plain cast, so the test proves nothing");
  });

  it("counts a waiting request's days from the company's midnight", async () => {
    const stale = app.get(StaleRequestsService);
    const fileAt = async (createdAt: Date, on: string): Promise<string> => {
      const row = await db.request.create({
        data: {
          employeeId: idOf.get(WAITER) as number,
          approverId: idOf.get(BOSS) as number,
          kind: "REMOTE_WORK",
          state: "PENDING",
          fromDate: new Date(`${on}T00:00:00.000Z`),
          toDate: new Date(`${on}T00:00:00.000Z`),
          reason: "e2e",
        },
      });
      await db.$executeRaw`UPDATE "Request" SET "createdAt" = ${createdAt} WHERE "id" = ${row.id}`;
      filed.push(row.id);
      return row.id;
    };
    // 23:50 on the 9th in Vietnam, the 9th in UTC too: four days by the company, three by UTC.
    const four = await fileAt(new Date("2031-03-09T16:50:00.000Z"), "2031-05-05");
    // 08:00 on the 11th in Vietnam, 01:00 UTC: three days by the company, two by UTC.
    const three = await fileAt(new Date("2031-03-11T01:00:00.000Z"), "2031-05-06");
    await stale.sweep(HALF_PAST_MIDNIGHT);

    assert.equal(await db.notification.count({ where: { requestId: four } }), 0, "a four-day wait was told as three");
    const told = await db.notification.findMany({ where: { requestId: three } });
    assert.ok(told.length > 0, "a three-day wait was not told");
    assert.ok(told.every((one) => one.daysWaited === 3));
  });

  it("counts a contract's days left from the company's midnight", async () => {
    const alerts = app.get(ContractAlertsService);
    const contractOf = async (code: string, endsOn: string): Promise<string> => {
      const made = await db.employmentContract.create({
        data: {
          employeeId: idOf.get(code) as number,
          kind: "FIXED_TERM",
          state: "ACTIVE",
          startDate: new Date("2030-04-14T00:00:00.000Z"),
          endDate: new Date(`${endsOn}T00:00:00.000Z`),
        },
      });
      return made.id;
    };
    const early = await contractOf(ENDING_29, "2031-04-12");
    const onMark = await contractOf(ENDING_30, "2031-04-13");
    await alerts.sweep(HALF_PAST_MIDNIGHT);

    assert.equal(await db.notification.count({ where: { contractId: early } }), 0, "29 days left was told as 30");
    const told = await db.notification.findMany({ where: { contractId: onMark } });
    assert.equal(told.length, 1, "30 days left by the company's calendar was not told");
    assert.equal(told[0]?.daysLeft, 30);
  });

  it("keeps the kiosk's clock skew from a live heartbeat, never from the broker's retained copy", async () => {
    const listener = app.get(EnrollmentListener);
    const beat = (ts: number, receivedAt: Date, retained: boolean): KioskMessage<Heartbeat> => ({
      topic: "heartbeat",
      deviceId: DEVICE,
      payload: { deviceId: DEVICE, ts, uptimeSeconds: 60, fwVersion: "0.0.0-e2e", modelVersion: "e2e" },
      receivedAt,
      retained,
    });
    const heard = new Date();
    await listener.onHeartbeat(beat(heard.getTime() - 150_000, heard, false));
    await listener.onHeartbeat(beat(heard.getTime() + 999_000, new Date(), true));
    await listener.onHeartbeat(beat(4_000, new Date(), false));

    const shown = await request(app.getHttpServer()).get(`/devices/${DEVICE}`).set("Authorization", `Bearer ${adminToken}`);
    assert.equal(shown.status, 200, JSON.stringify(shown.body));
    assert.equal(shown.body.clockSkewMs, -150_000, "the skew is not the live beat's");
  });
});
