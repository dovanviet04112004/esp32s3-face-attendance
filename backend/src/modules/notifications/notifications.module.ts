import { Global, Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { RealtimeModule } from "../realtime/realtime.module.js";
import { AudienceService } from "./audience.service.js";
import { BackupWatchService } from "./backup-watch.service.js";
import { ContractAlertsService } from "./contract-alerts.service.js";
import { MailerService } from "./mailer.service.js";
import { NoticeItemsService } from "./notice-items.service.js";
import { NotificationsController } from "./notifications.controller.js";
import { NotificationsService } from "./notifications.service.js";
import { StaleRequestsService } from "./stale-requests.service.js";
import { ReconcileSweep } from "./sweeps/reconcile.sweep.js";

@Global()
@Module({
  imports: [AuthModule, RealtimeModule],
  controllers: [NotificationsController],
  providers: [
    AudienceService,
    NotificationsService,
    NoticeItemsService,
    ContractAlertsService,
    StaleRequestsService,
    BackupWatchService,
    ReconcileSweep,
    MailerService,
  ],
  exports: [
    AudienceService,
    NotificationsService,
    NoticeItemsService,
    ContractAlertsService,
    StaleRequestsService,
    BackupWatchService,
    ReconcileSweep,
    MailerService,
  ],
})
export class NotificationsModule {}
