import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { MqttModule } from "../mqtt/mqtt.module.js";
import { BrokerAuthController } from "./broker-auth.controller.js";
import { CommandsService } from "./commands.service.js";
import { DevicesController } from "./devices.controller.js";
import { DevicesRegisterController } from "./devices-register.controller.js";
import { DevicesService } from "./devices.service.js";

@Module({
  imports: [AuthModule, MqttModule],
  // Machine routes first: GET /devices/me must match ahead of GET /devices/:id.
  controllers: [DevicesRegisterController, BrokerAuthController, DevicesController],
  providers: [DevicesService, CommandsService],
  exports: [DevicesService],
})
export class DevicesModule {}
