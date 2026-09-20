import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { PolicyModule } from "../policy/policy.module.js";
import { PayrollController } from "./payroll.controller.js";
import { PayrollService } from "./payroll.service.js";

@Module({
  imports: [AuthModule, PolicyModule],
  controllers: [PayrollController],
  providers: [PayrollService],
  exports: [PayrollService],
})
export class PayrollModule {}
