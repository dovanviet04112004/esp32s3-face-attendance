import { Module } from "@nestjs/common";

import { MqttService } from "./mqtt.service.js";

@Module({
  providers: [MqttService],
  exports: [MqttService],
})
export class MqttModule {}
