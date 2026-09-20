import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { TimesheetModule } from "../timesheet/timesheet.module.js";
import { LeaveController } from "./leave.controller.js";
import { LeaveService } from "./leave.service.js";

@Module({
  imports: [AuthModule, TimesheetModule],
  controllers: [LeaveController],
  providers: [LeaveService],
  exports: [LeaveService],
})
export class LeaveModule {}
