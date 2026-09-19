import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { LeaveController } from "./leave.controller.js";
import { LeaveService } from "./leave.service.js";

@Module({
  imports: [AuthModule],
  controllers: [LeaveController],
  providers: [LeaveService],
  exports: [LeaveService],
})
export class LeaveModule {}
