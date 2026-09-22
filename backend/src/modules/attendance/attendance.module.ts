import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { DevicesModule } from "../devices/devices.module.js";
import { RealtimeModule } from "../realtime/realtime.module.js";
import { AttendanceController } from "./attendance.controller.js";
import { AttendanceListener } from "./attendance.listener.js";
import { AttendanceService } from "./attendance.service.js";

@Module({
  imports: [AuthModule, DevicesModule, RealtimeModule],
  controllers: [AttendanceController],
  providers: [AttendanceService, AttendanceListener],
  exports: [AttendanceService],
})
export class AttendanceModule {}
