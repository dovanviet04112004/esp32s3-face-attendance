import { Body, Controller, Delete, Get, Param, ParseIntPipe, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { DeviceEnrollment } from "@prisma/client";

import { Roles } from "../../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { AssignDto } from "./dto/enrollment.dto.js";
import { EnrollmentService, type AssignableDevice } from "./enrollment.service.js";

@ApiTags("enrollment")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("enrollments")
export class EnrollmentController {
  constructor(private readonly enrollment: EnrollmentService) {}

  @Get("devices")
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "The kiosks a person can be put on, by name" })
  assignable(): Promise<AssignableDevice[]> {
    return this.enrollment.assignable();
  }

  @Post()
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Put a person on a kiosk's waiting list (KEHOACH 7.5)" })
  assign(@Body() body: AssignDto): Promise<DeviceEnrollment> {
    return this.enrollment.assign(body.deviceId, body.employeeId);
  }

  @Delete(":deviceId/:employeeId")
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Withdraw a person from a kiosk" })
  revoke(
    @Param("deviceId") deviceId: string,
    @Param("employeeId", ParseIntPipe) employeeId: number,
  ): Promise<DeviceEnrollment> {
    return this.enrollment.revoke(deviceId, employeeId);
  }

  @Post(":deviceId/resync")
  @Roles("ADMIN")
  @ApiOperation({ summary: "Send the kiosk the whole roster it should hold" })
  async resync(@Param("deviceId") deviceId: string): Promise<{ rosterVersion: number }> {
    return { rosterVersion: await this.enrollment.resync(deviceId) };
  }
}
