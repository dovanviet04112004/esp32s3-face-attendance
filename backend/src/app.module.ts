import { Module } from "@nestjs/common";
import { EventEmitterModule } from "@nestjs/event-emitter";

import { configModule } from "./config/configuration.js";
import { DatabaseModule } from "./database/database.module.js";
import { AttendanceModule } from "./modules/attendance/attendance.module.js";
import { MqttModule } from "./modules/mqtt/mqtt.module.js";

@Module({
  imports: [
    configModule,
    EventEmitterModule.forRoot(),
    DatabaseModule,
    MqttModule,
    AttendanceModule,
  ],
})
export class AppModule {}
