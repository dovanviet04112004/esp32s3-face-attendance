import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Worker } from "bullmq";

import { RedisService } from "../../database/redis.service.js";
import { LeaveYearService } from "../../modules/leave/leave-year.service.js";
import { FEED, RealtimeGateway } from "../../modules/realtime/realtime.gateway.js";
import { QUEUE, type LeaveJob } from "../queues.js";

@Injectable()
export class LeaveProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(LeaveProcessor.name);
  private worker?: Worker;

  constructor(
    private readonly redis: RedisService,
    private readonly years: LeaveYearService,
    private readonly feed: RealtimeGateway,
  ) {}

  onModuleInit(): void {
    this.worker = new Worker(
      QUEUE.leave,
      async (job) => {
        const body = job.data as LeaveJob;
        const opened = await this.years.open(body.year ?? this.years.thisYear());
        // Everyone's own balance moved, and no request carried the write for the change interceptor to see.
        if (opened.created + opened.carried > 0) {
          this.feed.announce(FEED.change, { resources: ["leave-balances"] });
        }
      },
      { connection: this.redis.client },
    );
    this.worker.on("failed", (job, error) => {
      this.log.error(`leave ${job?.id} failed: ${error.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
