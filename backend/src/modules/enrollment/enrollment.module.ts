import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { DevicesModule } from "../devices/devices.module.js";
import { MqttModule } from "../mqtt/mqtt.module.js";
import { RealtimeModule } from "../realtime/realtime.module.js";
import { ConsentController } from "./consent.controller.js";
import { ConsentService } from "./consent.service.js";
import { EnrollmentController } from "./enrollment.controller.js";
import { EnrollmentListener } from "./enrollment.listener.js";
import { EnrollmentService } from "./enrollment.service.js";

@Module({
  imports: [AuthModule, MqttModule, DevicesModule, RealtimeModule],
  controllers: [EnrollmentController, ConsentController],
  providers: [EnrollmentService, EnrollmentListener, ConsentService],
  exports: [EnrollmentService, ConsentService],
})
export class EnrollmentModule {}
