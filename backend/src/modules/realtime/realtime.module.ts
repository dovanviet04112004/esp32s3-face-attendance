import { Module } from "@nestjs/common";

import { DevicesModule } from "../devices/devices.module.js";
import { RealtimeGateway } from "./realtime.gateway.js";
import { RealtimeListener } from "./realtime.listener.js";

@Module({
  imports: [DevicesModule],
  providers: [RealtimeGateway, RealtimeListener],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
