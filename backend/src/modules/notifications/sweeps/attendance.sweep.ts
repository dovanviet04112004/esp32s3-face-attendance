import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";

import type { Env } from "../../../config/env.schema.js";
import { PrismaService } from "../../../database/prisma.service.js";
import { QUEUE_TOKEN, type Queues } from "../../../queue/queue.module.js";
import { JOB, QUEUE } from "../../../queue/queues.js";
import { ReportsService } from "../../reports/reports.service.js";
import { localDay, localMinutesSql, minutesIntoDay } from "../../timesheet/local-day.js";
import { itemKey, NoticeItemsService } from "../notice-items.service.js";
import {
  ATTENDANCE_OVERTIME_MINUTES,
  ATTENDANCE_PUSH_CRON,
  ATTENDANCE_PUSHED,
  TEAM_READERS,
  TEAM_SUMMARY_AFTER_FIRST_SHIFT_MINUTES,
  TEAM_SUMMARY_CRON,
} from "../notice-kinds.js";
import { NotificationsService, type Announced } from "../notifications.service.js";

const kBatch = 1000;
const kNoonMinutes = 720;

interface Found {
  employeeId: number;
  facts: Record<string, unknown>;
}

/** A built day off its shift is work for its own person until it settles,
 *  and each team's morning is summed up for its readers (KEHOACH 9.21.4).
 */
@Injectable()
export class AttendanceSweep implements OnModuleInit {
  private readonly log = new Logger(AttendanceSweep.name);

  constructor(
    private readonly db: PrismaService,
    private readonly items: NoticeItemsService,
    private readonly notices: NotificationsService,
    private readonly reports: ReportsService,
    private readonly config: ConfigService<Env, true>,
    @Inject(QUEUE_TOKEN) private readonly queues: Queues,
  ) {}

  // Upserting by scheduler id: a restart re-states it, never adds a second.
  async onModuleInit(): Promise<void> {
    const queue = this.queues[QUEUE.notify];
    await queue.upsertJobScheduler(
      "attendance-due",
      { pattern: ATTENDANCE_PUSH_CRON, tz: this.zone },
      { name: JOB.attendanceDue, data: { type: JOB.attendanceDue } },
    );
    await queue.upsertJobScheduler(
      "team-attendance",
      { pattern: TEAM_SUMMARY_CRON, tz: this.zone },
      { name: JOB.teamAttendance, data: { type: JOB.teamAttendance } },
    );
  }

  private get zone(): string {
    return this.config.get("APP_TIMEZONE", { infer: true });
  }

  /** Close what settled, then push each person's new missing punches and absences once, together.
   *  @ctx job | 08:30 daily; each item's push is claimed on it, so a second run says nothing
   */
  async sweep(): Promise<{ closed: number; pushed: number }> {
    const closed = await this.closeVanished();
    const pushed = await this.pushDue();
    this.log.log(`attendance swept: ${closed} closed, ${pushed} pushed`);
    return { closed, pushed };
  }

  /** Open without a sound the exceptions a built day holds, and clear the ones it holds no more.
   *  @ctx job | after the day build, for the whole day or one person; logs its own failures, never fails the build
   */
  async afterBuild(day: string, only: number | null = null): Promise<{ opened: number; cleared: number }> {
    try {
      const found = await this.exceptions(day, only);
      const opened = await this.openFor(day, found);
      const cleared = await this.clearSettled(day, only, found.map((one) => one.employeeId));
      return { opened, cleared };
    } catch (fell) {
      this.log.error(`exceptions of ${day} were not opened: ${String(fell)}`);
      return { opened: 0, cleared: 0 };
    }
  }

  // One definition of an exception, for opening and for clearing; a day corrected, covered by an approved request or paid has none.
  private exceptions(day: string, only: number | null): Promise<Found[]> {
    const punchAt = localMinutesSql(Prisma.sql`d."firstIn"`, this.zone);
    const start = Prisma.sql`(split_part(s."startTime", ':', 1)::int * 60 + split_part(s."startTime", ':', 2)::int)`;
    const end = Prisma.sql`(split_part(s."endTime", ':', 1)::int * 60 + split_part(s."endTime", ':', 2)::int)`;
    // A lone punch in the first half of the shift is the way in, so the way out is what is missing.
    const wentIn = Prisma.sql`(${punchAt} < COALESCE(${start} + ((${end} - ${start} + 1440) % 1440) / 2, ${kNoonMinutes}))`;
    return this.db.$queryRaw<Found[]>`
      WITH settled AS (
        SELECT d."employeeId", d."state", d."lateMinutes", d."earlyLeaveMinutes", d."overtimeMinutes",
               (d."punchCount" = 1 AND ${wentIn}) AS "outMissing",
               (d."punchCount" = 1 AND NOT ${wentIn}) AS "inMissing"
          FROM "AttendanceDay" d
          JOIN "Employee" e ON e."id" = d."employeeId"
          LEFT JOIN "Shift" s ON s."id" = d."shiftId"
         WHERE d."date" = ${day}::date
           AND d."adjustedById" IS NULL
           AND (${only}::int IS NULL OR d."employeeId" = ${only}::int)
           AND EXISTS (SELECT 1 FROM "User" u WHERE u."employeeId" = d."employeeId" AND u."active")
           AND NOT EXISTS (
             SELECT 1 FROM "Request" q
              WHERE q."employeeId" = d."employeeId" AND q."state" = 'APPROVED'
                AND ${day}::date BETWEEN q."fromDate" AND q."toDate"
           )
           AND NOT EXISTS (
             SELECT 1 FROM "PayrollPeriod" p
              WHERE p."state" <> 'OPEN' AND ${day}::date BETWEEN p."startDate" AND p."endDate"
                AND (p."legalEntityId" IS NULL OR p."legalEntityId" = e."legalEntityId")
           )
      ),
      coded AS (
        SELECT "employeeId",
               CASE WHEN "outMissing" THEN 'OUT' WHEN "inMissing" THEN 'IN' END AS "missing",
               CASE WHEN "state" = 'ABSENT' THEN true END AS "absent",
               CASE WHEN "lateMinutes" > 0 AND NOT "inMissing" THEN "lateMinutes" END AS "lateMinutes",
               CASE WHEN "earlyLeaveMinutes" > 0 AND NOT "outMissing" THEN "earlyLeaveMinutes" END AS "earlyMinutes",
               CASE WHEN "overtimeMinutes" >= ${ATTENDANCE_OVERTIME_MINUTES}::int THEN "overtimeMinutes" END AS "overtimeMinutes"
          FROM settled
      )
      SELECT "employeeId",
             jsonb_strip_nulls(jsonb_build_object('day', ${day}::text, 'lateMinutes', "lateMinutes", 'earlyMinutes', "earlyMinutes",
               'overtimeMinutes', "overtimeMinutes", 'missing', "missing", 'absent', "absent")) AS "facts"
        FROM coded
       WHERE num_nonnulls("missing", "absent", "lateMinutes", "earlyMinutes", "overtimeMinutes") > 0
    `;
  }

  // Two statements a batch: the items, then a row for each open login of each person, unread and not pushed yet.
  private async openFor(day: string, found: Found[]): Promise<number> {
    let opened = 0;
    for (let at = 0; at < found.length; at += kBatch) {
      const batch = found.slice(at, at + kBatch);
      const made = await this.db.$queryRaw<{ fresh: boolean }[]>`
        INSERT INTO "NoticeItem" ("id", "key", "queue", "subjectType", "subjectId", "employeeId", "facts")
        SELECT gen_random_uuid()::text, 'attendance:' || f."employeeId" || ':' || ${day}::text, 'ATTENDANCE'::"NoticeQueue",
               'PERSON_DAY'::"NoticeSubject", f."employeeId" || ':' || ${day}::text, f."employeeId", f."facts"
          FROM unnest(${batch.map((one) => one.employeeId)}::int[], ${batch.map((one) => JSON.stringify(one.facts))}::jsonb[])
               AS f("employeeId", "facts")
        ON CONFLICT ("key") DO UPDATE SET "facts" = EXCLUDED."facts"
         WHERE "NoticeItem"."state" = 'OPEN' AND "NoticeItem"."facts" IS DISTINCT FROM EXCLUDED."facts"
        RETURNING (xmax = 0) AS "fresh"
      `;
      opened += made.filter((one) => one.fresh).length;
      const seated = await this.db.$queryRaw<(Announced & { fresh: boolean })[]>`
        INSERT INTO "Notification" ("id", "userId", "kind", "itemId", "subjectType", "subjectId", "subjectEmployeeId", "dedupKey", "facts")
        SELECT gen_random_uuid()::text, u."id", 'ATTENDANCE_EXCEPTION'::"NoticeKind", i."id", i."subjectType", i."subjectId",
               i."employeeId", i."key", i."facts"
          FROM "NoticeItem" i
          JOIN "User" u ON u."employeeId" = i."employeeId" AND u."active"
         WHERE i."queue" = 'ATTENDANCE' AND i."state" = 'OPEN'
           AND i."subjectId" = ANY(${batch.map((one) => `${one.employeeId}:${day}`)}::text[])
           FOR KEY SHARE OF u
        ON CONFLICT ("userId", "dedupKey") DO UPDATE SET "facts" = EXCLUDED."facts"
         WHERE "Notification"."facts" IS DISTINCT FROM EXCLUDED."facts"
        RETURNING "id", "userId", "dedupKey", false AS "renotify", "createdAt" AS "at", (xmax = 0) AS "fresh"
      `;
      await this.notices.announce(
        "ATTENDANCE_EXCEPTION",
        seated.filter((one) => one.fresh),
        false,
      );
    }
    return opened;
  }

  // A rebuilt day whose deviations are gone clears its work (KEHOACH 9.21.4).
  private async clearSettled(day: string, only: number | null, still: number[]): Promise<number> {
    const shut = await this.db.$queryRaw<{ id: string }[]>`
      UPDATE "NoticeItem" SET "state" = 'CLEARED', "closedAt" = now()::timestamp(3)
       WHERE "queue" = 'ATTENDANCE' AND "state" = 'OPEN' AND "subjectId" LIKE ${`%:${day}`}
         AND (${only}::int IS NULL OR "employeeId" = ${only}::int)
         AND NOT ("employeeId" = ANY(${still}::int[]))
      RETURNING "id"
    `;
    await this.items.settle(shut.map((one) => one.id));
    return shut.length;
  }

  /** Close exceptions whose reason is gone: a corrected day or one an approved request covers clears; a locked period expires it.
   *  @ctx any | after a correction, a decision and a lock, in the morning sweep and the hourly reconcile; one UPDATE
   */
  async closeVanished(employeeId: number | null = null): Promise<number> {
    const day = Prisma.sql`split_part(n."subjectId", ':', 2)::date`;
    const shut = await this.db.$queryRaw<{ id: string }[]>`
      UPDATE "NoticeItem" i
         SET "state" = x."state"::"NoticeItemState", "closedAt" = now()::timestamp(3)
        FROM (
          SELECT n."id", CASE WHEN k."locked" OR e."id" IS NULL OR d."employeeId" IS NULL THEN 'EXPIRED' ELSE 'CLEARED' END AS "state"
            FROM "NoticeItem" n
            LEFT JOIN "Employee" e ON e."id" = n."employeeId"
            LEFT JOIN "AttendanceDay" d ON d."employeeId" = n."employeeId" AND d."date" = ${day}
           CROSS JOIN LATERAL (
             SELECT EXISTS (
               SELECT 1 FROM "PayrollPeriod" p
                WHERE p."state" <> 'OPEN' AND ${day} BETWEEN p."startDate" AND p."endDate"
                  AND (p."legalEntityId" IS NULL OR p."legalEntityId" = e."legalEntityId")
             ) AS "locked"
           ) k
           WHERE n."queue" = 'ATTENDANCE' AND n."state" = 'OPEN'
             AND (${employeeId}::int IS NULL OR n."employeeId" = ${employeeId}::int)
             AND (k."locked" OR e."id" IS NULL OR d."employeeId" IS NULL OR d."adjustedById" IS NOT NULL
                  OR EXISTS (
                    SELECT 1 FROM "Request" q
                     WHERE q."employeeId" = n."employeeId" AND q."state" = 'APPROVED' AND ${day} BETWEEN q."fromDate" AND q."toDate"
                  ))
        ) x
       WHERE i."id" = x."id" AND i."state" = 'OPEN'
      RETURNING i."id"
    `;
    await this.items.settle(shut.map((one) => one.id));
    return shut.length;
  }

  /** Expire the summaries of days gone, then open today's for each reader half an hour into their earliest shift.
   *  @ctx job | every fifteen minutes through the morning; one summary a reader a day, told once
   */
  async summarise(now: Date = new Date()): Promise<{ opened: number; expired: number }> {
    const day = localDay(now, this.zone);
    const minute = minutesIntoDay(now, this.zone);
    const expired = await this.closeSummaries(now);
    const readers = await this.db.user.findMany({
      where: { active: true, role: { in: [...TEAM_READERS] } },
      select: { id: true, role: true, employeeId: true },
    });
    let opened = 0;
    for (const reader of readers) {
      const ref = { id: reader.id, part: day };
      if (await this.db.noticeItem.findUnique({ where: { key: itemKey("TEAM_ATTENDANCE", ref) }, select: { id: true } })) {
        continue;
      }
      const tally = await this.reports.teamTally({ userId: reader.id, role: reader.role, employeeId: reader.employeeId }, now);
      if (tally === null || minute < tally.firstStartMinutes + TEAM_SUMMARY_AFTER_FIRST_SHIFT_MINUTES) {
        continue;
      }
      const { firstStartMinutes: _first, ...counts } = tally;
      if (await this.items.open("TEAM_ATTENDANCE", { ...ref, employeeId: null }, { facts: { day, ...counts } })) {
        opened += 1;
      }
    }
    this.log.log(`team summaries: ${opened} opened, ${expired} expired`);
    return { opened, expired };
  }

  /** Expire every summary of a day gone; a summary speaks of one morning.
   *  @ctx any | the morning sweep and the hourly reconcile; one UPDATE
   */
  async closeSummaries(now: Date = new Date()): Promise<number> {
    const shut = await this.db.$queryRaw<{ id: string }[]>`
      UPDATE "NoticeItem" SET "state" = 'EXPIRED', "closedAt" = now()::timestamp(3)
       WHERE "queue" = 'TEAM_ATTENDANCE' AND "state" = 'OPEN' AND "key" NOT LIKE ${`%:${localDay(now, this.zone)}`}
      RETURNING "id"
    `;
    await this.items.settle(shut.map((one) => one.id));
    return shut.length;
  }

  // Each item's one push is claimed on it; a person then hears all of theirs not yet read, at once.
  private async pushDue(): Promise<number> {
    const claimed = await this.db.$queryRaw<{ id: string }[]>`
      UPDATE "NoticeItem" SET "lastMark" = 1
       WHERE "queue" = 'ATTENDANCE' AND "state" = 'OPEN' AND "lastMark" IS NULL
         AND jsonb_exists_any("facts", ${[...ATTENDANCE_PUSHED]}::text[])
      RETURNING "id"
    `;
    if (claimed.length === 0) {
      return 0;
    }
    const rows = await this.db.notification.findMany({
      where: { itemId: { in: claimed.map((one) => one.id) }, readAt: null, leftAt: null },
      select: { id: true, userId: true, dedupKey: true },
      orderBy: { createdAt: "desc" },
    });
    const held = new Map<string, { id: string; dedupKey: string | null }[]>();
    for (const row of rows) {
      held.set(row.userId, [...(held.get(row.userId) ?? []), row]);
    }
    return this.notices.pushTogether("ATTENDANCE_EXCEPTION", held);
  }
}
