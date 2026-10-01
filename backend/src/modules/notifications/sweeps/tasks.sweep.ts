import { Inject, Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { TaskOwner } from "@prisma/client";

import type { Env } from "../../../config/env.schema.js";
import { PrismaService } from "../../../database/prisma.service.js";
import { QUEUE_TOKEN, type Queues } from "../../../queue/queue.module.js";
import { JOB, QUEUE } from "../../../queue/queues.js";
import { localDay } from "../../timesheet/local-day.js";
import { NoticeItemsService } from "../notice-items.service.js";
import { DUE_MARKS } from "../notice-kinds.js";

interface Due {
  taskId: string;
  employeeId: number;
  daysLeft: number;
}

interface Unopened {
  id: string;
  employeeId: number;
  ownerRole: TaskOwner;
  dueOn: Date;
}

const kDailyCron = "10 8 * * *";

/** Onboarding and offboarding tasks: reminded on their due day and the day after, then a warning (KEHOACH 9.21.4). */
@Injectable()
export class TasksSweep implements OnModuleInit {
  private readonly log = new Logger(TasksSweep.name);

  constructor(
    private readonly db: PrismaService,
    private readonly items: NoticeItemsService,
    private readonly config: ConfigService<Env, true>,
    @Inject(QUEUE_TOKEN) private readonly queues: Queues,
  ) {}

  // Upserting by scheduler id: a restart re-states it, never adds a second.
  async onModuleInit(): Promise<void> {
    await this.queues[QUEUE.notify].upsertJobScheduler(
      "tasks-due-daily",
      { pattern: kDailyCron, tz: this.config.get("APP_TIMEZONE", { infer: true }) },
      { name: JOB.tasksDue, data: { type: JOB.tasksDue } },
    );
  }

  /** Close what is done, open what a path left unopened, then speak at the due marks passed.
   *  @ctx job | a mark is claimed on the item, so two sweeps, or a missed day, say it once
   */
  async sweep(now: Date = new Date()): Promise<{ told: number; opened: number; closed: number }> {
    const closed = await this.closeVanished();
    const opened = await this.openMissing();
    const today = localDay(now, this.config.get("APP_TIMEZONE", { infer: true }));
    const rows = await this.db.$queryRaw<Due[]>`
      SELECT t."id" AS "taskId", r."employeeId", (t."dueOn" - ${today}::date)::int AS "daysLeft"
        FROM "ChecklistTask" t
        JOIN "ChecklistRun" r ON r."id" = t."runId"
       WHERE t."doneAt" IS NULL AND (t."dueOn" - ${today}::date) <= ${(DUE_MARKS.TASKS ?? [0])[0]}::int
    `;
    let told = 0;
    for (const row of rows) {
      if (await this.items.speakDue("TASKS", { id: row.taskId, employeeId: row.employeeId }, row.daysLeft)) {
        told += 1;
      }
    }
    this.log.log(`tasks swept: ${told} told, ${opened} opened, ${closed} closed`);
    return { told, opened, closed };
  }

  /** Close task work whose task is done, in its doer's name, or gone.
   *  @ctx any | the sweep and the hourly reconcile call it; one UPDATE, then the rows read
   */
  async closeVanished(): Promise<number> {
    const shut = await this.db.$queryRaw<{ id: string }[]>`
      UPDATE "NoticeItem" i
         SET "state" = x."state"::"NoticeItemState", "outcome" = x."outcome"::"NoticeOutcome",
             "actorId" = x."actorId", "closedAt" = x."closedAt"
        FROM (
          SELECT n."id",
                 CASE WHEN t."id" IS NULL THEN 'EXPIRED' ELSE 'DONE' END AS "state",
                 CASE WHEN t."id" IS NOT NULL THEN 'COMPLETED' END AS "outcome",
                 t."doneById" AS "actorId",
                 COALESCE(t."doneAt", now()::timestamp(3)) AS "closedAt"
            FROM "NoticeItem" n
            LEFT JOIN "ChecklistTask" t ON t."id" = n."subjectId"
           WHERE n."queue" = 'TASKS' AND n."state" = 'OPEN' AND (t."id" IS NULL OR t."doneAt" IS NOT NULL)
        ) x
       WHERE i."id" = x."id" AND i."state" = 'OPEN'
      RETURNING i."id"
    `;
    await this.items.settle(shut.map((one) => one.id));
    return shut.length;
  }

  /** Open work for unfinished tasks no path opened; their owners find it already read. */
  async openMissing(): Promise<number> {
    const missing = await this.db.$queryRaw<Unopened[]>`
      SELECT t."id", r."employeeId", t."ownerRole", t."dueOn"
        FROM "ChecklistTask" t
        JOIN "ChecklistRun" r ON r."id" = t."runId"
       WHERE t."doneAt" IS NULL AND NOT EXISTS (SELECT 1 FROM "NoticeItem" i WHERE i."key" = 'tasks:' || t."id")
    `;
    for (const task of missing) {
      await this.items.open(
        "TASKS",
        { id: task.id, employeeId: task.employeeId },
        { joining: "quiet", dueAt: task.dueOn, facts: { owner: task.ownerRole } },
      );
    }
    return missing.length;
  }
}
