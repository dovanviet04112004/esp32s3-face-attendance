import { Module } from "@nestjs/common";

import { LeaveProcessor } from "../../queue/processors/leave.processor.js";
import { AuthModule } from "../auth/auth.module.js";
import { RealtimeModule } from "../realtime/realtime.module.js";
import { TimesheetModule } from "../timesheet/timesheet.module.js";
import { LeaveYearService } from "./leave-year.service.js";
import { LeaveController } from "./leave.controller.js";
import { LeaveService } from "./leave.service.js";

@Module({
  imports: [AuthModule, TimesheetModule, RealtimeModule],
  controllers: [LeaveController],
  providers: [LeaveService, LeaveYearService, LeaveProcessor],
  exports: [LeaveService, LeaveYearService],
})
export class LeaveModule {}
