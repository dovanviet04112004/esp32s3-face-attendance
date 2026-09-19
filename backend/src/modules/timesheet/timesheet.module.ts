import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { TimesheetService } from "./timesheet.service.js";

@Module({
  imports: [AuthModule],
  providers: [TimesheetService],
  exports: [TimesheetService],
})
export class TimesheetModule {}
