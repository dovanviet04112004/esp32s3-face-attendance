import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Worker } from "bullmq";

import { RedisService } from "../../database/redis.service.js";
import { TimesheetService } from "../../modules/timesheet/timesheet.service.js";
import { QUEUE, type TimesheetJob } from "../queues.js";

@Injectable()
export class TimesheetProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(TimesheetProcessor.name);
  private worker?: Worker;

  constructor(
    private readonly redis: RedisService,
    private readonly timesheet: TimesheetService,
  ) {}

  onModuleInit(): void {
    this.worker = new Worker(
      QUEUE.timesheet,
      async (job) => {
        const body = job.data as TimesheetJob;
        const built = await this.timesheet.buildRange(body.from, body.to);
        this.log.log(`built ${built.rows} row(s) across ${built.days} day(s)`);
      },
      { connection: this.redis.client },
    );
    this.worker.on("failed", (job, error) => {
      this.log.error(`timesheet ${job?.id} failed: ${error.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
