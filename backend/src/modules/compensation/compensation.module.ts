import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { CompensationController } from "./compensation.controller.js";
import { CompensationService } from "./compensation.service.js";

@Module({
  imports: [AuthModule],
  controllers: [CompensationController],
  providers: [CompensationService],
  exports: [CompensationService],
})
export class CompensationModule {}
