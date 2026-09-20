import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { PolicyController } from "./policy.controller.js";
import { PolicyService } from "./policy.service.js";

@Module({
  imports: [AuthModule],
  controllers: [PolicyController],
  providers: [PolicyService],
  exports: [PolicyService],
})
export class PolicyModule {}
