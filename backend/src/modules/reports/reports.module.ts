import { Module } from "@nestjs/common";

import { ReportProcessor } from "../../queue/processors/report.processor.js";
import { AuthModule } from "../auth/auth.module.js";
import { ReportsController } from "./reports.controller.js";
import { ReportsService } from "./reports.service.js";

@Module({
  imports: [AuthModule],
  controllers: [ReportsController],
  providers: [ReportsService, ReportProcessor],
  exports: [ReportsService],
})
export class ReportsModule {}
