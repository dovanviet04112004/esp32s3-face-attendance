import { Module } from "@nestjs/common";

import { NotifyProcessor } from "../../queue/processors/notify.processor.js";
import { ReportProcessor } from "../../queue/processors/report.processor.js";
import { ScopeModule } from "../../common/scope/scope.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { PolicyModule } from "../policy/policy.module.js";
import { ProfileModule } from "../profile/profile.module.js";
import { ReportsController } from "./reports.controller.js";
import { ReportsService } from "./reports.service.js";

@Module({
  // NotifyProcessor is provided here, so what its jobs delegate to has to
  // be reachable from here too.
  imports: [AuthModule, ScopeModule, PolicyModule, ProfileModule],
  controllers: [ReportsController],
  providers: [ReportsService, ReportProcessor, NotifyProcessor],
  exports: [ReportsService],
})
export class ReportsModule {}
