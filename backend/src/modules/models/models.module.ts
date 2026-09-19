import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { MqttModule } from "../mqtt/mqtt.module.js";
import { ModelsController } from "./models.controller.js";
import { ModelsService } from "./models.service.js";

@Module({
  imports: [AuthModule, MqttModule],
  controllers: [ModelsController],
  providers: [ModelsService],
  exports: [ModelsService],
})
export class ModelsModule {}
