import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { DevicesController } from "./devices.controller.js";
import { DevicesRegisterController } from "./devices-register.controller.js";
import { DevicesService } from "./devices.service.js";

@Module({
  imports: [AuthModule],
  controllers: [DevicesController, DevicesRegisterController],
  providers: [DevicesService],
  exports: [DevicesService],
})
export class DevicesModule {}
