import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Worker } from "bullmq";

import { RedisService } from "../../database/redis.service.js";
import { ReportsService } from "../../modules/reports/reports.service.js";
import { QUEUE, type ReportJob } from "../queues.js";

@Injectable()
export class ReportProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(ReportProcessor.name);
  private worker?: Worker;

  constructor(
    private readonly redis: RedisService,
    private readonly reports: ReportsService,
  ) {}

  onModuleInit(): void {
    this.worker = new Worker(
      QUEUE.report,
      async (job) => {
        const { from, to } = job.data as ReportJob;
        // Running twice writes the same cache entry, which is what lets the
        // queue deliver at least once without a second result (CLAUDE.md 4.3).
        const rows = await this.reports.summary(new Date(from), new Date(to));
        this.log.log(`report ${job.id} covered ${rows.length} employees`);
        return { employees: rows.length };
      },
      { connection: this.redis.client },
    );
    this.worker.on("failed", (job, error) => {
      this.log.error(`report ${job?.id} failed: ${error.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
