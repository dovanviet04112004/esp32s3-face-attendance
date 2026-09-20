import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { createTransport, type Transporter } from "nodemailer";

import type { Env } from "../../config/env.schema.js";
import type { MailBody } from "../payroll/mail-text.js";

const SECURE_PORT = 465;

@Injectable()
export class MailerService {
  private readonly log = new Logger(MailerService.name);
  private readonly transport?: Transporter;

  constructor(private readonly config: ConfigService<Env, true>) {
    const host = this.config.get("MAIL_HOST", { infer: true });
    if (!host) {
      this.log.warn("no MAIL_HOST: mail is logged instead of sent");
      return;
    }
    const user = this.config.get("MAIL_USER", { infer: true });
    const port = this.config.get("MAIL_PORT", { infer: true });
    this.transport = createTransport({
      host,
      port,
      secure: port === SECURE_PORT,
      auth: user ? { user, pass: this.config.get("MAIL_PASSWORD", { infer: true }) } : undefined,
    });
  }

  /** Whether a message left the machine, so a caller can decide what to
   *  record. Without a host configured it only reaches the log.
   */
  async send(to: string, body: MailBody): Promise<boolean> {
    if (!this.transport) {
      this.log.log(`would send "${body.subject}" to ${to}`);
      return false;
    }
    await this.transport.sendMail({
      from:
        this.config.get("MAIL_FROM", { infer: true }) ??
        this.config.get("MAIL_USER", { infer: true }),
      to,
      subject: body.subject,
      text: body.text,
    });
    return true;
  }
}
