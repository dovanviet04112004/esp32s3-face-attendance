import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { MqttModule } from "../mqtt/mqtt.module.js";
import { RealtimeModule } from "../realtime/realtime.module.js";
import { ModelsController, ReleaseFilesController } from "./models.controller.js";
import { ModelsService } from "./models.service.js";
import { PublishGuard } from "./publish.guard.js";

@Module({
  imports: [AuthModule, MqttModule, RealtimeModule],
  controllers: [ModelsController, ReleaseFilesController],
  providers: [ModelsService, PublishGuard],
  exports: [ModelsService],
})
export class ModelsModule {}
