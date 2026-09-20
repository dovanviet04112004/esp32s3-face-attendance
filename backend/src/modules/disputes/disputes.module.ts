import { Module } from "@nestjs/common";

import { ScopeModule } from "../../common/scope/scope.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { NotificationsModule } from "../notifications/notifications.module.js";
import { DisputesController } from "./disputes.controller.js";
import { DisputesService } from "./disputes.service.js";

@Module({
  imports: [AuthModule, ScopeModule, NotificationsModule],
  controllers: [DisputesController],
  providers: [DisputesService],
  exports: [DisputesService],
})
export class DisputesModule {}
