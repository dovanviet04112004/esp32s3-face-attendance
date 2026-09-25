import { Body, Controller, Delete, Get, HttpStatus, Param, ParseIntPipe, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { DeviceEnrollment } from "@prisma/client";

import { ApiErrors } from "../../common/decorators/api-docs.decorator.js";
import { Roles } from "../../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { AssignableDeviceView, AssignDto, EnrollmentView, KioskStandingView, RosterView } from "./dto/enrollment.dto.js";
import { EnrollmentService, type AssignableDevice, type KioskStanding } from "./enrollment.service.js";

@ApiTags("enrollment")
@ApiBearerAuth()
@ApiErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND)
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("enrollments")
export class EnrollmentController {
  constructor(private readonly enrollment: EnrollmentService) {}

  @Get("devices")
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "The kiosks a person can be put on, by name" })
  @ApiOkResponse({ type: [AssignableDeviceView] })
  assignable(): Promise<AssignableDevice[]> {
    return this.enrollment.assignable();
  }

  @Get("employees/:employeeId")
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Where a person stands on each kiosk" })
  @ApiOkResponse({ type: [KioskStandingView] })
  standing(@Param("employeeId", ParseIntPipe) employeeId: number): Promise<KioskStanding[]> {
    return this.enrollment.standing(employeeId);
  }

  @Post()
  @Roles("ADMIN", "HR")
  @ApiOperation({
    summary: "Put a person on a kiosk: sent the face held on its model, or asked for; a held pair goes to RETAKE (KEHOACH 7.5)",
  })
  @ApiCreatedResponse({ type: EnrollmentView })
  assign(@Body() body: AssignDto): Promise<DeviceEnrollment> {
    return this.enrollment.assign(body.deviceId, body.employeeId);
  }

  @Delete(":deviceId/:employeeId")
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Withdraw a person from a kiosk" })
  @ApiOkResponse({ type: EnrollmentView })
  revoke(
    @Param("deviceId") deviceId: string,
    @Param("employeeId", ParseIntPipe) employeeId: number,
  ): Promise<DeviceEnrollment> {
    return this.enrollment.revoke(deviceId, employeeId);
  }

  @Post(":deviceId/resync")
  @Roles("ADMIN")
  @ApiOperation({ summary: "Send the kiosk the whole roster it should hold" })
  @ApiCreatedResponse({ type: RosterView })
  async resync(@Param("deviceId") deviceId: string): Promise<{ rosterVersion: number }> {
    return { rosterVersion: await this.enrollment.resync(deviceId) };
  }
}
