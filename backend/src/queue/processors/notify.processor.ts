import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Worker } from "bullmq";

import type { Env } from "../../config/env.schema.js";
import { RedisService } from "../../database/redis.service.js";
import { QUEUE, type NotifyJob } from "../queues.js";

const POST_TIMEOUT_MS = 10000;

@Injectable()
export class NotifyProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(NotifyProcessor.name);
  private worker?: Worker;

  constructor(
    private readonly redis: RedisService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onModuleInit(): void {
    this.worker = new Worker(
      QUEUE.notify,
      async (job) => {
        const body = job.data as NotifyJob;
        const url = this.config.get("NOTIFY_WEBHOOK_URL", { infer: true });
        if (!url) {
          this.log.warn(`${body.deviceId}: ${body.reason} (no webhook configured)`);
          return;
        }
        // A third party that is slow or down is the reason this is a job at
        // all, so a failure here throws and BullMQ tries again later.
        const sent = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(POST_TIMEOUT_MS),
        });
        if (!sent.ok) {
          throw new Error(`webhook answered ${sent.status}`);
        }
      },
      { connection: this.redis.client },
    );
    this.worker.on("failed", (job, error) => {
      this.log.error(`notify ${job?.id} failed: ${error.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
