import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { TimesheetController } from "./timesheet.controller.js";
import { TimesheetService } from "./timesheet.service.js";

@Module({
  imports: [AuthModule],
  controllers: [TimesheetController],
  providers: [TimesheetService],
  exports: [TimesheetService],
})
export class TimesheetModule {}
