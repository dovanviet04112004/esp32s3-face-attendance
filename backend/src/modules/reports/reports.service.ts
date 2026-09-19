import { createHash } from "node:crypto";

import { Inject, Injectable } from "@nestjs/common";
import type { Queue } from "bullmq";

import { CACHE } from "../../common/cache/cache-keys.js";
import { CacheService } from "../../common/cache/cache.service.js";
import { PrismaService } from "../../database/prisma.service.js";
import { QUEUE, type ReportJob } from "../../queue/queues.js";
import { QUEUE_TOKEN, type Queues } from "../../queue/queue.module.js";

/** One employee's punches inside a range. */
export interface AttendanceTally {
  employeeId: number;
  fullName: string;
  punches: number;
  firstAt: string | null;
  lastAt: string | null;
  unsyncedClock: number;
}

@Injectable()
export class ReportsService {
  constructor(
    private readonly db: PrismaService,
    private readonly cache: CacheService,
    @Inject(QUEUE_TOKEN) private readonly queues: Queues,
  ) {}

  /** Punches per employee between two instants, cached for a quarter hour. */
  summary(from: Date, to: Date): Promise<AttendanceTally[]> {
    const range = `${from.toISOString()}_${to.toISOString()}`;
    return this.cache.through(CACHE.report("summary", range), () => this.build(from, to));
  }

  /** Hand a long roll-up to the queue; it outlives the request that asked. */
  async schedule(job: ReportJob): Promise<string> {
    const queue: Queue = this.queues[QUEUE.report];
    // The range decides the id, so asking twice enqueues one run. It is hashed
    // because BullMQ refuses a colon, and an ISO instant is mostly colons.
    const id = createHash("sha256").update(`${job.type}|${job.from}|${job.to}`).digest("hex");
    const queued = await queue.add(QUEUE.report, job, { jobId: id });
    return queued.id ?? "";
  }

  /** Grouped in Postgres: a month of punches does not belong in the heap. */
  private async build(from: Date, to: Date): Promise<AttendanceTally[]> {
    const rows = await this.db.$queryRaw<
      {
        employeeId: number;
        fullName: string;
        punches: bigint;
        firstAt: Date | null;
        lastAt: Date | null;
        unsyncedClock: bigint;
      }[]
    >`
      SELECT a."employeeId",
             e."fullName",
             count(*)                                        AS "punches",
             min(a."ts")                                     AS "firstAt",
             max(a."ts")                                     AS "lastAt",
             count(*) FILTER (WHERE a."clockUnsynced")        AS "unsyncedClock"
      FROM "AttendanceRecord" a
      JOIN "Employee" e ON e."id" = a."employeeId"
      WHERE a."ts" >= ${from} AND a."ts" <= ${to}
      GROUP BY a."employeeId", e."fullName"
      ORDER BY e."fullName"
    `;
    return rows.map((row) => ({
      employeeId: row.employeeId,
      fullName: row.fullName,
      punches: Number(row.punches),
      firstAt: row.firstAt?.toISOString() ?? null,
      lastAt: row.lastAt?.toISOString() ?? null,
      unsyncedClock: Number(row.unsyncedClock),
    }));
  }
}
