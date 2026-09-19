import { Module } from "@nestjs/common";

import { DevicesModule } from "../devices/devices.module.js";
import { AttendanceListener } from "./attendance.listener.js";
import { AttendanceService } from "./attendance.service.js";

@Module({
  imports: [DevicesModule],
  providers: [AttendanceService, AttendanceListener],
  exports: [AttendanceService],
})
export class AttendanceModule {}
