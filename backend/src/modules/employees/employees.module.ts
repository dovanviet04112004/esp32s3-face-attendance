import { Module } from "@nestjs/common";

import { PeopleProcessor } from "../../queue/processors/people.processor.js";
import { AuthModule } from "../auth/auth.module.js";
import { EnrollmentModule } from "../enrollment/enrollment.module.js";
import { OnboardingModule } from "../onboarding/onboarding.module.js";
import { RealtimeModule } from "../realtime/realtime.module.js";
import { UsersModule } from "../users/users.module.js";
import { BulkService } from "./bulk.service.js";
import { EmployeesController } from "./employees.controller.js";
import { EmployeesService } from "./employees.service.js";

@Module({
  imports: [AuthModule, EnrollmentModule, OnboardingModule, RealtimeModule, UsersModule],
  controllers: [EmployeesController],
  providers: [EmployeesService, BulkService, PeopleProcessor],
  exports: [EmployeesService, BulkService],
})
export class EmployeesModule {}
