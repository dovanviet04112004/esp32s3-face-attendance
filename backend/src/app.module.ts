import { Module } from "@nestjs/common";
import { EventEmitterModule } from "@nestjs/event-emitter";

import { configModule } from "./config/configuration.js";
import { DatabaseModule } from "./database/database.module.js";
import { AttendanceModule } from "./modules/attendance/attendance.module.js";
import { AuthModule } from "./modules/auth/auth.module.js";
import { DevicesModule } from "./modules/devices/devices.module.js";
import { EmployeesModule } from "./modules/employees/employees.module.js";
import { MqttModule } from "./modules/mqtt/mqtt.module.js";
import { ShiftsModule } from "./modules/shifts/shifts.module.js";

@Module({
  imports: [
    configModule,
    EventEmitterModule.forRoot(),
    DatabaseModule,
    AuthModule,
    MqttModule,
    AttendanceModule,
    EmployeesModule,
    DevicesModule,
    ShiftsModule,
  ],
})
export class AppModule {}
