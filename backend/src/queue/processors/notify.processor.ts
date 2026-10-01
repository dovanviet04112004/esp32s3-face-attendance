import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Worker } from "bullmq";

import type { Env } from "../../config/env.schema.js";
import { RedisService } from "../../database/redis.service.js";
import { MailerService } from "../../modules/notifications/mailer.service.js";
import { NotificationsService } from "../../modules/notifications/notifications.service.js";
import { passwordChangedMail, setupMail } from "../../modules/payroll/mail-text.js";
import { ProfileService } from "../../modules/profile/profile.service.js";
import { BackupSweep } from "../../modules/notifications/sweeps/backup.sweep.js";
import { CleanupSweep } from "../../modules/notifications/sweeps/cleanup.sweep.js";
import { ContractsSweep } from "../../modules/notifications/sweeps/contracts.sweep.js";
import { KioskSweep } from "../../modules/notifications/sweeps/kiosk.sweep.js";
import { ProbationSweep } from "../../modules/notifications/sweeps/probation.sweep.js";
import { ReconcileSweep } from "../../modules/notifications/sweeps/reconcile.sweep.js";
import { StalledSweep } from "../../modules/notifications/sweeps/stalled.sweep.js";
import { PrismaService } from "../../database/prisma.service.js";
import { DEFAULT_MAIL_LOCALE } from "../../modules/payroll/mail-text.js";
import { QUEUE, type NotifyJob, type PasswordChangedJob, type PasswordSetupJob } from "../queues.js";

const POST_TIMEOUT_MS = 10000;

@Injectable()
export class NotifyProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(NotifyProcessor.name);
  private worker?: Worker;

  constructor(
    private readonly redis: RedisService,
    private readonly contracts: ContractsSweep,
    private readonly probation: ProbationSweep,
    private readonly mailer: MailerService,
    private readonly profile: ProfileService,
    private readonly stale: StalledSweep,
    private readonly backups: BackupSweep,
    private readonly reconcile: ReconcileSweep,
    private readonly cleanup: CleanupSweep,
    private readonly kiosk: KioskSweep,
    private readonly notices: NotificationsService,
    private readonly db: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onModuleInit(): void {
    this.worker = new Worker(
      QUEUE.notify,
      async (job) => {
        const body = job.data as NotifyJob;
        if (body.type === "contracts-ending") {
          await this.contracts.sweep();
          return;
        }
        if (body.type === "probation-due") {
          await this.probation.sweep();
          return;
        }
        if (body.type === "requests-stale") {
          await this.stale.sweep();
          return;
        }
        if (body.type === "backup-watch") {
          await this.backups.sweep();
          return;
        }
        if (body.type === "notice-reconcile") {
          await this.reconcile.sweep();
          return;
        }
        if (body.type === "notice-cleanup") {
          await this.cleanup.sweep();
          return;
        }
        if (body.type === "kiosk-alerts") {
          await this.kiosk.sweep();
          return;
        }
        if (body.type === "notice-fanout") {
          await this.notices.fanOut(body);
          return;
        }
        if (body.type === "notice-gather") {
          await this.notices.gather(body.userId, new Date(body.since));
          return;
        }
        if (body.type === "password-setup") {
          await this.mailSetup(body);
          return;
        }
        if (body.type === "password-changed") {
          await this.mailChanged(body);
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
    const body = setupMail(account.employee?.locale ?? DEFAULT_MAIL_LOCALE, {
      fullName: account.employee?.fullName ?? account.email,
      url: job.link,
      hours: this.config.get("PASSWORD_SETUP_TTL_HOURS", { infer: true }),
      minutes: this.config.get("PASSWORD_RESET_TTL_MINUTES", { infer: true }),
      reason: job.reason,
    });
    await this.mailer.send(account.email, body);
  }

  private async mailChanged(job: PasswordChangedJob): Promise<void> {
    const account = await this.db.user.findUnique({
      where: { id: job.userId },
      select: { email: true, employee: { select: { fullName: true, locale: true } } },
    });
    if (!account) {
      return;
    }
    const locale = account.employee?.locale ?? DEFAULT_MAIL_LOCALE;
    await this.mailer.send(account.email, passwordChangedMail(locale, account.employee?.fullName ?? account.email));
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
  }
}
