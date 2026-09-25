import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { Worker } from "bullmq";

import { RedisService } from "../../database/redis.service.js";
import { EmployeesService } from "../../modules/employees/employees.service.js";
import { FEED, RealtimeGateway } from "../../modules/realtime/realtime.gateway.js";
import { JOB, QUEUE, type PeopleJob } from "../queues.js";

@Injectable()
export class PeopleProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(PeopleProcessor.name);
  private worker?: Worker;

  constructor(
    private readonly redis: RedisService,
    private readonly employees: EmployeesService,
    private readonly feed: RealtimeGateway,
  ) {}

  onModuleInit(): void {
    this.worker = new Worker(
      QUEUE.people,
      async (job) => {
        const body = job.data as PeopleJob;
        const closed =
          body.type === JOB.leavingsNow
            ? await this.employees.closeMany(body.employeeIds, body.through, body.actorId)
            : await this.employees.closeDue(this.employees.today());
        this.log.log(`${body.type}: closed ${closed.length} record(s)`);
        // No request carried this write, so the change interceptor never saw it.
        if (closed.length > 0) {
          this.feed.publish(FEED.change, { resources: ["employees", "offboard", "enrollments"] }, closed);
        }
      },
      { connection: this.redis.client },
    );
    this.worker.on("failed", (job, error) => {
      this.log.error(`people ${job?.id} failed: ${error.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
