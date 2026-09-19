import { Module } from "@nestjs/common";
import { EventEmitterModule } from "@nestjs/event-emitter";

import { configModule } from "./config/configuration.js";
import { DatabaseModule } from "./database/database.module.js";
import { ScopeModule } from "./common/scope/scope.module.js";
import { AttendanceModule } from "./modules/attendance/attendance.module.js";
import { OrgModule } from "./modules/org/org.module.js";
import { TimesheetModule } from "./modules/timesheet/timesheet.module.js";
import { AuditModule } from "./modules/audit/audit.module.js";
import { AuthModule } from "./modules/auth/auth.module.js";
import { DevicesModule } from "./modules/devices/devices.module.js";
import { EmployeesModule } from "./modules/employees/employees.module.js";
import { EnrollmentModule } from "./modules/enrollment/enrollment.module.js";
import { ModelsModule } from "./modules/models/models.module.js";
import { MqttModule } from "./modules/mqtt/mqtt.module.js";
import { RealtimeModule } from "./modules/realtime/realtime.module.js";
import { ReportsModule } from "./modules/reports/reports.module.js";
import { ShiftsModule } from "./modules/shifts/shifts.module.js";
import { UsersModule } from "./modules/users/users.module.js";
import { CacheModule } from "./common/cache/cache.module.js";
import { QueueModule } from "./queue/queue.module.js";

@Module({
  imports: [
    configModule,
    EventEmitterModule.forRoot(),
    DatabaseModule,
    AuthModule,
    MqttModule,
    ScopeModule,
    AttendanceModule,
    OrgModule,
    TimesheetModule,
    EmployeesModule,
    DevicesModule,
    ShiftsModule,
    EnrollmentModule,
    ModelsModule,
    CacheModule,
    QueueModule,
    RealtimeModule,
    ReportsModule,
    AuditModule,
    UsersModule,
  ],
})
export class AppModule {}
