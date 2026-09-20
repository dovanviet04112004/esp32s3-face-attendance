import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Worker } from "bullmq";
import { createTransport, type Transporter } from "nodemailer";

import type { Env } from "../../config/env.schema.js";
import { PrismaService } from "../../database/prisma.service.js";
import { RedisService } from "../../database/redis.service.js";
import { payslipMail } from "../../modules/payroll/mail-text.js";
import { QUEUE, type PayrollJob } from "../queues.js";

@Injectable()
export class PayrollProcessor implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(PayrollProcessor.name);
  private worker?: Worker;
  private mail?: Transporter;

  constructor(
    private readonly db: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  onModuleInit(): void {
    this.mail = this.transport();
    this.worker = new Worker(
      QUEUE.payroll,
      (job) => this.deliver(job.data as PayrollJob),
      { connection: this.redis.client },
    );
    this.worker.on("failed", (job, error) => {
      this.log.error(`payroll ${job?.id} failed: ${error.message}`);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.worker?.close();
    this.mail?.close();
  }

  private transport(): Transporter | undefined {
    const host = this.config.get("MAIL_HOST", { infer: true });
    if (!host) {
      this.log.warn("no MAIL_HOST: payslip mail is off");
      return undefined;
    }
    const user = this.config.get("MAIL_USER", { infer: true });
    const pass = this.config.get("MAIL_PASSWORD", { infer: true });
    const port = this.config.get("MAIL_PORT", { infer: true });
    return createTransport({
      host,
      port,
      secure: port === 465,
      auth: user ? { user, pass } : undefined,
    });
  }

  private async deliver(job: PayrollJob): Promise<void> {
    const slip = await this.db.payslip.findUnique({
      where: { id: job.payslipId },
      include: {
        employee: { select: { fullName: true, personalEmail: true, locale: true } },
        period: { select: { year: true, month: true } },
      },
    });
    if (!slip) {
      this.log.warn(`payslip ${job.payslipId} is gone, nothing to send`);
      return;
    }
    // At-least-once delivery means this job can arrive twice; the column is
    // what makes the second arrival a no-op (KEHOACH 9.11).
    if (slip.sentAt !== null) {
      return;
    }
    const to = slip.employee.personalEmail;
    if (!to) {
      this.log.warn(`employee ${slip.employeeId} has no address`);
      return;
    }
    const root = this.config.get("APP_PUBLIC_URL", { infer: true });
    const body = payslipMail(slip.employee.locale, {
      fullName: slip.employee.fullName,
      month: slip.period.month,
      year: slip.period.year,
      url: `${root}/${slip.employee.locale}/me/payslips`,
    });
    if (this.mail) {
      await this.mail.sendMail({
        from: this.config.get("MAIL_FROM", { infer: true }) ?? this.config.get("MAIL_USER", { infer: true }),
        to,
        subject: body.subject,
        text: body.text,
      });
    } else {
      this.log.log(`would send "${body.subject}" to ${to}`);
    }
    await this.db.payslip.update({
      where: { id: slip.id },
      data: { state: "SENT", sentAt: new Date() },
    });
  }
}
