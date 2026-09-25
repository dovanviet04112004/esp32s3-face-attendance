import { Module } from "@nestjs/common";

import { PayrollProcessor } from "../../queue/processors/payroll.processor.js";
import { AuthModule } from "../auth/auth.module.js";
import { LeaveModule } from "../leave/leave.module.js";
import { PolicyModule } from "../policy/policy.module.js";
import { RealtimeModule } from "../realtime/realtime.module.js";
import { AdvanceController } from "./advance.controller.js";
import { AdvanceService } from "./advance.service.js";
import { PayrollController } from "./payroll.controller.js";
import { PayrollService } from "./payroll.service.js";

@Module({
  imports: [AuthModule, PolicyModule, LeaveModule, RealtimeModule],
  controllers: [PayrollController, AdvanceController],
  providers: [PayrollService, AdvanceService, PayrollProcessor],
  exports: [PayrollService],
})
export class PayrollModule {}
