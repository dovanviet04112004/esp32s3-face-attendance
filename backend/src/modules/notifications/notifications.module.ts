import { Global, Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { RealtimeModule } from "../realtime/realtime.module.js";
import { ReportsModule } from "../reports/reports.module.js";
import { AudienceService } from "./audience.service.js";
import { MailerService } from "./mailer.service.js";
import { NoticeItemsService } from "./notice-items.service.js";
import { NotificationsController } from "./notifications.controller.js";
import { NotificationsService } from "./notifications.service.js";
import { SubjectsService } from "./subjects.service.js";
import { AttendanceSweep } from "./sweeps/attendance.sweep.js";
import { BackupSweep } from "./sweeps/backup.sweep.js";
import { CleanupSweep } from "./sweeps/cleanup.sweep.js";
import { ContractsSweep } from "./sweeps/contracts.sweep.js";
import { DocumentsSweep } from "./sweeps/documents.sweep.js";
import { KioskSweep } from "./sweeps/kiosk.sweep.js";
import { ProbationSweep } from "./sweeps/probation.sweep.js";
import { ReconcileSweep } from "./sweeps/reconcile.sweep.js";
import { StalledSweep } from "./sweeps/stalled.sweep.js";
import { TasksSweep } from "./sweeps/tasks.sweep.js";

@Global()
@Module({
  imports: [AuthModule, RealtimeModule, ReportsModule],
  controllers: [NotificationsController],
  providers: [
    AudienceService,
    NotificationsService,
    NoticeItemsService,
    SubjectsService,
    ContractsSweep,
    ProbationSweep,
    StalledSweep,
    BackupSweep,
    ReconcileSweep,
    CleanupSweep,
    KioskSweep,
    TasksSweep,
    DocumentsSweep,
    AttendanceSweep,
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
    BackupSweep,
    ReconcileSweep,
    CleanupSweep,
    KioskSweep,
    TasksSweep,
    DocumentsSweep,
    AttendanceSweep,
    MailerService,
  ],
})
export class NotificationsModule {}
