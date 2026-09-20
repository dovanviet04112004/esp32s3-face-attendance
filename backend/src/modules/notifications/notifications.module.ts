import { Global, Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { ContractAlertsService } from "./contract-alerts.service.js";
import { NotificationsController } from "./notifications.controller.js";
import { NotificationsService } from "./notifications.service.js";

@Global()
@Module({
  imports: [AuthModule],
  controllers: [NotificationsController],
  providers: [NotificationsService, ContractAlertsService],
  exports: [NotificationsService, ContractAlertsService],
})
export class NotificationsModule {}
