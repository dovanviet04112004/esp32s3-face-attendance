import { Global, Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { ContractAlertsService } from "./contract-alerts.service.js";
import { MailerService } from "./mailer.service.js";
import { NotificationsController } from "./notifications.controller.js";
import { NotificationsService } from "./notifications.service.js";
import { StaleRequestsService } from "./stale-requests.service.js";

@Global()
@Module({
  imports: [AuthModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, ContractAlertsService, StaleRequestsService, MailerService],
  exports: [NotificationsService, ContractAlertsService, StaleRequestsService, MailerService],
})
export class NotificationsModule {}
