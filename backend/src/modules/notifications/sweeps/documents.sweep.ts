import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma } from "@prisma/client";

import type { Env } from "../../../config/env.schema.js";
import { PrismaService } from "../../../database/prisma.service.js";
import { QUEUE_TOKEN, type Queues } from "../../../queue/queue.module.js";
import { JOB, QUEUE } from "../../../queue/queues.js";
import { localDateSql, localDay } from "../../timesheet/local-day.js";
import { NoticeItemsService } from "../notice-items.service.js";
import { QUEUE_MARKS } from "../notice-kinds.js";
import { NotificationsService, type Announced } from "../notifications.service.js";

const kBatch = 1000;
const kDailyCron = "20 8 * * *";

/** Every reader of a document's newest version holds work of their own until they sign it (KEHOACH 9.21.4). */
@Injectable()
export class DocumentsSweep implements OnModuleInit {
  private readonly log = new Logger(DocumentsSweep.name);

  constructor(
    private readonly db: PrismaService,
    private readonly items: NoticeItemsService,
    private readonly notices: NotificationsService,
    private readonly config: ConfigService<Env, true>,
    @Inject(QUEUE_TOKEN) private readonly queues: Queues,
  ) {}

  // Upserting by scheduler id: a restart re-states it, never adds a second.
  async onModuleInit(): Promise<void> {
    await this.queues[QUEUE.notify].upsertJobScheduler(
      "documents-due-daily",
      { pattern: kDailyCron, tz: this.config.get("APP_TIMEZONE", { infer: true }) },
      { name: JOB.documentsDue, data: { type: JOB.documentsDue } },
    );
  }

  /** Close what is signed or stale, open the newest versions for readers who joined since, then remind at the marks.
   *  @ctx job | daily; a mark is claimed on each item, so a missed day or a second run says it once
   */
  async sweep(now: Date = new Date()): Promise<{ opened: number; reminded: number; closed: number }> {
    const closed = await this.closeVanished();
    const newest = await this.db.$queryRaw<{ id: string }[]>`
      SELECT DISTINCT ON (v."documentId") v."id"
        FROM "DocumentVersion" v
        JOIN "Document" d ON d."id" = v."documentId" AND d."active"
       ORDER BY v."documentId", v."version" DESC
    `;
    let opened = 0;
    for (const version of newest) {
      opened += await this.fanOut(version.id);
    }
    const reminded = await this.remindDue(now);
    this.log.log(`documents swept: ${opened} opened, ${reminded} reminded, ${closed} closed`);
    return { opened, reminded, closed };
  }

  /** Open a version's work for each reader with an open login and no signature, a thousand at a time.
   *  @ctx job | after a publish and in the daily sweep; an older version opens nothing, a second run adds nothing
   */
  async fanOut(versionId: string): Promise<number> {
    const version = await this.db.documentVersion.findUnique({ where: { id: versionId }, include: { document: true } });
    const newer = version ? await this.db.documentVersion.count({ where: { documentId: version.documentId, version: { gt: version.version } } }) : 0;
    if (!version || !version.document.active || newer > 0) {
      return 0;
    }
    await this.closeVanished(version.documentId);
    const target = version.document;
    let opened = 0;
    let after = 0;
    for (;;) {
      const readers = await this.db.$queryRaw<{ id: number }[]>`
        SELECT e."id" FROM "Employee" e
         WHERE e."active" AND e."id" > ${after}
           AND (${target.departmentId}::text IS NULL OR e."departmentId" = ${target.departmentId})
           AND (${target.jobTitleId}::text IS NULL OR e."jobTitleId" = ${target.jobTitleId})
           AND EXISTS (SELECT 1 FROM "User" u WHERE u."employeeId" = e."id" AND u."active")
           AND NOT EXISTS (SELECT 1 FROM "DocumentAck" a WHERE a."versionId" = ${versionId} AND a."employeeId" = e."id")
         ORDER BY e."id"
         LIMIT ${kBatch}
      `;
      if (readers.length > 0) {
        opened += await this.openFor(versionId, readers.map((one) => one.id));
      }
      if (readers.length < kBatch) {
        return opened;
      }
      after = readers[readers.length - 1].id;
    }
  }

  // Two statements a batch: the items, then a row for each open login that lacks one, told as new work.
  private async openFor(versionId: string, readers: number[]): Promise<number> {
    const made = await this.db.$queryRaw<{ id: string }[]>`
      INSERT INTO "NoticeItem" ("id", "key", "queue", "subjectType", "subjectId", "employeeId")
      SELECT gen_random_uuid()::text, 'documents:' || ${versionId}::text || ':' || r."id", 'DOCUMENTS'::"NoticeQueue",
             'DOCUMENT'::"NoticeSubject", ${versionId}::text, r."id"
        FROM unnest(${readers}::int[]) AS r("id")
      ON CONFLICT ("key") DO NOTHING
      RETURNING "id"
    `;
    const seated = await this.db.$queryRaw<Announced[]>`
      INSERT INTO "Notification" ("id", "userId", "kind", "itemId", "subjectType", "subjectId", "subjectEmployeeId", "dedupKey", "facts")
      SELECT gen_random_uuid()::text, u."id", 'DOCUMENT_TO_SIGN'::"NoticeKind", i."id", i."subjectType", i."subjectId", i."employeeId", i."key", i."facts"
        FROM "NoticeItem" i
        JOIN "User" u ON u."employeeId" = i."employeeId" AND u."active"
       WHERE i."queue" = 'DOCUMENTS' AND i."state" = 'OPEN' AND i."subjectId" = ${versionId}::text AND i."employeeId" = ANY(${readers}::int[])
         FOR KEY SHARE OF u
      ON CONFLICT ("userId", "dedupKey") DO NOTHING
      RETURNING "id", "userId", "dedupKey", false AS "renotify", "createdAt" AS "at"
    `;
    await this.notices.announce("DOCUMENT_TO_SIGN", seated);
    return made.length;
  }

  // The highest mark passed is claimed on every unsigned item at once, then their rows surface together.
  private async remindDue(now: Date): Promise<number> {
    const zone = this.config.get("APP_TIMEZONE", { infer: true });
    const today = localDay(now, zone);
    const marks = [...(QUEUE_MARKS.DOCUMENTS ?? [])];
    const waited = Prisma.sql`(${today}::date - ${localDateSql(Prisma.sql`v."publishedAt"`, zone)})`;
    const claimed = await this.db.$queryRaw<{ id: string; waited: number }[]>`
      UPDATE "NoticeItem" i SET "lastMark" = x."mark"
        FROM (
          SELECT n."id", ${waited}::int AS "waited",
                 (SELECT max(m) FROM unnest(${marks}::int[]) AS m WHERE m <= ${waited}) AS "mark"
            FROM "NoticeItem" n
            JOIN "DocumentVersion" v ON v."id" = n."subjectId"
           WHERE n."queue" = 'DOCUMENTS' AND n."state" = 'OPEN'
        ) x
       WHERE i."id" = x."id" AND x."mark" IS NOT NULL AND (i."lastMark" IS NULL OR i."lastMark" < x."mark")
      RETURNING i."id", x."waited"
    `;
    if (claimed.length === 0) {
      return 0;
    }
    const surfaced = await this.db.$queryRaw<Announced[]>`
      UPDATE "Notification" n
         SET "facts" = n."facts" || jsonb_build_object('daysWaited', x."waited"), "daysWaited" = x."waited",
             "readAt" = NULL, "archivedAt" = NULL, "remindedAt" = now(), "remindCount" = n."remindCount" + 1
        FROM unnest(${claimed.map((one) => one.id)}::text[], ${claimed.map((one) => one.waited)}::int[]) AS x("itemId", "waited")
       WHERE n."itemId" = x."itemId" AND n."leftAt" IS NULL
      RETURNING n."id", n."userId", n."dedupKey", true AS "renotify", n."remindedAt" AS "at"
    `;
    await this.notices.announce("DOCUMENT_TO_SIGN", surfaced);
    return claimed.length;
  }

  /** Close signing work that is signed, superseded, retired, or about a reader outside the document's audience.
   *  @ctx any | the sweep, a publish, a retired document and the hourly reconcile; one UPDATE, then the rows read
   */
  async closeVanished(documentId: string | null = null): Promise<number> {
    const shut = await this.db.$queryRaw<{ id: string }[]>`
      UPDATE "NoticeItem" i
         SET "state" = x."state"::"NoticeItemState", "outcome" = x."outcome"::"NoticeOutcome",
             "actorId" = x."actorId", "closedAt" = x."closedAt"
        FROM (
          SELECT n."id",
                 CASE WHEN a."id" IS NOT NULL THEN 'DONE' ELSE 'EXPIRED' END AS "state",
                 CASE WHEN a."id" IS NOT NULL THEN 'SIGNED' END AS "outcome",
                 CASE WHEN a."id" IS NOT NULL
                      THEN (SELECT u."id" FROM "User" u WHERE u."employeeId" = n."employeeId" ORDER BY u."active" DESC LIMIT 1) END AS "actorId",
                 COALESCE(a."ackAt", now()::timestamp(3)) AS "closedAt"
            FROM "NoticeItem" n
            LEFT JOIN "DocumentVersion" v ON v."id" = n."subjectId"
            LEFT JOIN "Document" d ON d."id" = v."documentId"
            LEFT JOIN "Employee" e ON e."id" = n."employeeId"
            LEFT JOIN "DocumentAck" a ON a."versionId" = n."subjectId" AND a."employeeId" = n."employeeId"
           WHERE n."queue" = 'DOCUMENTS' AND n."state" = 'OPEN'
             AND (${documentId}::text IS NULL OR v."documentId" = ${documentId}::text)
             AND (a."id" IS NOT NULL OR v."id" IS NULL OR NOT d."active" OR e."id" IS NULL OR NOT e."active"
                  OR (d."departmentId" IS NOT NULL AND d."departmentId" IS DISTINCT FROM e."departmentId")
                  OR (d."jobTitleId" IS NOT NULL AND d."jobTitleId" IS DISTINCT FROM e."jobTitleId")
                  OR EXISTS (SELECT 1 FROM "DocumentVersion" w WHERE w."documentId" = v."documentId" AND w."version" > v."version"))
        ) x
       WHERE i."id" = x."id" AND i."state" = 'OPEN'
      RETURNING i."id"
    `;
    await this.items.settle(shut.map((one) => one.id));
    return shut.length;
  }
}
