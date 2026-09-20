import { Global, Module } from "@nestjs/common";
import { Queue } from "bullmq";

import { RedisService } from "../database/redis.service.js";
import { QUEUE, type QueueName } from "./queues.js";

export const QUEUE_TOKEN = "BULLMQ_QUEUES";

export type Queues = Record<QueueName, Queue>;

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
        const make = (name: QueueName): Queue =>
          new Queue(name, { connection: redis.client, defaultJobOptions: defaults });
        return {
          [QUEUE.report]: make(QUEUE.report),
          [QUEUE.notify]: make(QUEUE.notify),
          [QUEUE.payroll]: make(QUEUE.payroll),
          [QUEUE.timesheet]: make(QUEUE.timesheet),
        };
      },
    },
  ],
  exports: [QUEUE_TOKEN],
})
export class QueueModule {}
