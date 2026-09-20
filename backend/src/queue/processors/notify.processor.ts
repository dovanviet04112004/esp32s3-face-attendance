import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Worker } from "bullmq";

import type { Env } from "../../config/env.schema.js";
import { RedisService } from "../../database/redis.service.js";
import { ContractAlertsService } from "../../modules/notifications/contract-alerts.service.js";
import { MailerService } from "../../modules/notifications/mailer.service.js";
import { setupMail } from "../../modules/payroll/mail-text.js";
import { ProfileService } from "../../modules/profile/profile.service.js";
import { PrismaService } from "../../database/prisma.service.js";
import { QUEUE, type NotifyJob, type PasswordSetupJob } from "../queues.js";

const POST_TIMEOUT_MS = 10000;

@Injectable()
export class NotifyProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(NotifyProcessor.name);
  private worker?: Worker;

  constructor(
    private readonly redis: RedisService,
    private readonly alerts: ContractAlertsService,
    private readonly mailer: MailerService,
    private readonly profile: ProfileService,
    private readonly db: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onModuleInit(): void {
    this.worker = new Worker(
      QUEUE.notify,
      async (job) => {
        const body = job.data as NotifyJob;
        if (body.type === "contracts-ending") {
          await this.alerts.sweep();
          return;
        }
        if (body.type === "password-setup") {
          await this.mailSetup(body);
          return;
        }
        if (body.type === "profile-notice") {
          await this.profile.mailNotice(body.changeId);
          return;
        }
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

  private async mailSetup(job: PasswordSetupJob): Promise<void> {
    const account = await this.db.user.findUnique({
      where: { id: job.userId },
      select: { email: true, employee: { select: { fullName: true, locale: true } } },
    });
    if (!account) {
      this.log.warn(`account ${job.userId} is gone, no invitation to send`);
      return;
    }
    const body = setupMail(account.employee?.locale ?? "vi", {
      fullName: account.employee?.fullName ?? account.email,
      url: job.link,
      hours: this.config.get("PASSWORD_SETUP_TTL_HOURS", { infer: true }),
    });
    await this.mailer.send(account.email, body);
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
