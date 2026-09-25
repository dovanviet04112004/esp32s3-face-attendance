import { Global, Module } from "@nestjs/common";
import { Queue } from "bullmq";

import { RedisService } from "../database/redis.service.js";
import { QUEUE, type QueueName } from "./queues.js";

export const QUEUE_TOKEN = "BULLMQ_QUEUES";

export type Queues = Record<QueueName, Queue>;

const HOUR_S = 3600;

@Global()
@Module({
  providers: [
    {
      provide: QUEUE_TOKEN,
      inject: [RedisService],
      useFactory: (redis: RedisService): Queues => {
        // Every job retries with a growing gap, because the thing it waits on
        // is usually a third party that came back a moment later.
        const defaults = {
          attempts: 3,
          backoff: { type: "exponential" as const, delay: 1000 },
          removeOnComplete: 100,
          removeOnFail: 500,
        };
        const make = (name: QueueName, kept = {}): Queue =>
          new Queue(name, { connection: redis.client, defaultJobOptions: { ...defaults, ...kept } });
        return {
          [QUEUE.report]: make(QUEUE.report),
          // Setup mail carries a live password link, and only its hash may outlast the letter (KEHOACH 9.4).
          [QUEUE.notify]: make(QUEUE.notify, { removeOnComplete: true, removeOnFail: { age: HOUR_S } }),
          [QUEUE.payroll]: make(QUEUE.payroll),
          [QUEUE.timesheet]: make(QUEUE.timesheet),
        };
      },
    },
  ],
  exports: [QUEUE_TOKEN],
})
export class QueueModule {}
