import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { TimesheetController } from "./timesheet.controller.js";
import { TimesheetProcessor } from "../../queue/processors/timesheet.processor.js";
import { TimesheetService } from "./timesheet.service.js";

@Module({
  imports: [AuthModule],
  controllers: [TimesheetController],
  providers: [TimesheetService, TimesheetProcessor],
  exports: [TimesheetService],
})
export class TimesheetModule {}
