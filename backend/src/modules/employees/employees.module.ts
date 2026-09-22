import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { OnboardingModule } from "../onboarding/onboarding.module.js";
import { UsersModule } from "../users/users.module.js";
import { EmployeesController } from "./employees.controller.js";
import { EmployeesService } from "./employees.service.js";

@Module({
  imports: [AuthModule, OnboardingModule, UsersModule],
  controllers: [EmployeesController],
  providers: [EmployeesService],
  exports: [EmployeesService],
})
export class EmployeesModule {}
