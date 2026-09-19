import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { DevicesModule } from "../devices/devices.module.js";
import { MqttModule } from "../mqtt/mqtt.module.js";
import { EnrollmentController } from "./enrollment.controller.js";
import { EnrollmentListener } from "./enrollment.listener.js";
import { EnrollmentService } from "./enrollment.service.js";

@Module({
  imports: [AuthModule, MqttModule, DevicesModule],
  controllers: [EnrollmentController],
  providers: [EnrollmentService, EnrollmentListener],
  exports: [EnrollmentService],
})
export class EnrollmentModule {}
