import { Module } from "@nestjs/common";

import { ScopeModule } from "../../common/scope/scope.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { ShiftsController } from "./shifts.controller.js";
import { ShiftsService } from "./shifts.service.js";

@Module({
  imports: [AuthModule, ScopeModule],
  controllers: [ShiftsController],
  providers: [ShiftsService],
  exports: [ShiftsService],
})
export class ShiftsModule {}
