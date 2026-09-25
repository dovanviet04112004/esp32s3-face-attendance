import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";

import { ScopeModule } from "../../common/scope/scope.module.js";
import { AuthModule } from "../auth/auth.module.js";
import { DevicesModule } from "../devices/devices.module.js";
import { RealtimeGateway } from "./realtime.gateway.js";
import { RealtimeListener } from "./realtime.listener.js";

@Module({
  imports: [JwtModule.register({}), ScopeModule, AuthModule, DevicesModule],
  providers: [RealtimeGateway, RealtimeListener],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
