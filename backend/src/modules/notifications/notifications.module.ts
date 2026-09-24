import { Global, Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { LeaveModule } from "../leave/leave.module.js";
import { RealtimeModule } from "../realtime/realtime.module.js";
import { BackupWatchService } from "./backup-watch.service.js";
import { ContractAlertsService } from "./contract-alerts.service.js";
import { MailerService } from "./mailer.service.js";
import { NotificationsController } from "./notifications.controller.js";
import { NotificationsService } from "./notifications.service.js";
import { StaleRequestsService } from "./stale-requests.service.js";

@Global()
@Module({
  imports: [AuthModule, LeaveModule, RealtimeModule],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    ContractAlertsService,
    StaleRequestsService,
    BackupWatchService,
    MailerService,
  ],
  exports: [
    NotificationsService,
    ContractAlertsService,
    StaleRequestsService,
    BackupWatchService,
    MailerService,
  ],
})
export class NotificationsModule {}
