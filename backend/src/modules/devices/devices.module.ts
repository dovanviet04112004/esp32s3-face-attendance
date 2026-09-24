import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { BrokerAuthController } from "./broker-auth.controller.js";
import { DevicesController } from "./devices.controller.js";
import { DevicesRegisterController } from "./devices-register.controller.js";
import { DevicesService } from "./devices.service.js";

@Module({
  imports: [AuthModule],
  // Machine routes first: GET /devices/me must match ahead of GET /devices/:id.
  controllers: [DevicesRegisterController, BrokerAuthController, DevicesController],
  providers: [DevicesService],
  exports: [DevicesService],
})
export class DevicesModule {}
