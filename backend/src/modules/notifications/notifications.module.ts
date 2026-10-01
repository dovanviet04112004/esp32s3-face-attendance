import { Global, Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { RealtimeModule } from "../realtime/realtime.module.js";
import { AudienceService } from "./audience.service.js";
import { BackupWatchService } from "./backup-watch.service.js";
import { MailerService } from "./mailer.service.js";
import { NoticeItemsService } from "./notice-items.service.js";
import { NotificationsController } from "./notifications.controller.js";
import { NotificationsService } from "./notifications.service.js";
import { SubjectsService } from "./subjects.service.js";
import { CleanupSweep } from "./sweeps/cleanup.sweep.js";
import { ContractsSweep } from "./sweeps/contracts.sweep.js";
import { ProbationSweep } from "./sweeps/probation.sweep.js";
import { ReconcileSweep } from "./sweeps/reconcile.sweep.js";
import { StalledSweep } from "./sweeps/stalled.sweep.js";

@Global()
@Module({
  imports: [AuthModule, RealtimeModule],
  controllers: [NotificationsController],
  providers: [
    AudienceService,
    NotificationsService,
    NoticeItemsService,
    SubjectsService,
    ContractsSweep,
    ProbationSweep,
    StalledSweep,
    BackupWatchService,
    ReconcileSweep,
    CleanupSweep,
    MailerService,
  ],
  exports: [
    AudienceService,
    NotificationsService,
    NoticeItemsService,
    SubjectsService,
    ContractsSweep,
    ProbationSweep,
    StalledSweep,
    BackupWatchService,
    ReconcileSweep,
    CleanupSweep,
    MailerService,
  ],
})
export class NotificationsModule {}
