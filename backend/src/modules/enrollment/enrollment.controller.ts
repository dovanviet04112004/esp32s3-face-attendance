import { Body, Controller, Delete, Get, HttpStatus, Param, ParseIntPipe, Post, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";
import type { DeviceEnrollment } from "@prisma/client";

import { ApiErrors } from "../../common/decorators/api-docs.decorator.js";
import { AuditedInService } from "../../common/decorators/audited.decorator.js";
import { RateBucket } from "../../common/decorators/rate-bucket.decorator.js";
import { Roles } from "../../common/decorators/roles.decorator.js";
import { ErrorBody } from "../../common/dto/error-body.dto.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { Reach } from "../../common/scope/reach.js";
import { CurrentViewer, type Viewer } from "../../common/scope/viewer.js";
import { THROTTLE } from "../auth/auth.types.js";
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
  @Reach("catalogue")
  @ApiOperation({ summary: "The kiosks a person can be put on, by name" })
  @ApiOkResponse({ type: [AssignableDeviceView] })
  assignable(): Promise<AssignableDevice[]> {
    return this.enrollment.assignable();
  }

  @Get("me")
  @ApiOperation({ summary: "The kiosks where I must capture my face again, for a newer recognition model" })
  @ApiOkResponse({ type: [AssignableDeviceView], description: "Empty when none needs it, or for an account with no employee record" })
  mine(@CurrentViewer() viewer: Viewer): Promise<AssignableDevice[]> {
    return viewer.employeeId === null ? Promise.resolve([]) : this.enrollment.recaptureAt(viewer.employeeId);
  }

  @Get("employees/:employeeId")
  @Roles("ADMIN", "HR")
  @Reach("person")
  @ApiOperation({ summary: "Where a person stands on each kiosk" })
  @ApiOkResponse({ type: [KioskStandingView], description: "Kiosks holding or awaiting the person, by kiosk id" })
  @ApiParam({ name: "employeeId", description: "Employee id", example: 42 })
  standing(
    @CurrentViewer() viewer: Viewer,
    @Param("employeeId", ParseIntPipe) employeeId: number,
  ): Promise<KioskStanding[]> {
    return this.enrollment.standing(viewer, employeeId);
  }

  @Post()
  @AuditedInService()
  @Roles("ADMIN", "HR")
  @Reach("person")
  @ApiOperation({
    summary: "Put a person on a kiosk: sent the face held on its model, or asked for; a held pair goes to RETAKE (KEHOACH 7.5)",
  })
  @ApiCreatedResponse({ type: EnrollmentView })
  @ApiConflictResponse({ type: ErrorBody, description: "DEVICE_NOT_APPROVED: the kiosk is waiting or revoked" })
  assign(@CurrentViewer() viewer: Viewer, @Body() body: AssignDto): Promise<DeviceEnrollment> {
    return this.enrollment.assignAs(viewer, body.deviceId, body.employeeId);
  }

  @Delete(":deviceId/:employeeId")
  @AuditedInService()
  @Roles("ADMIN", "HR")
  @Reach("person")
  @ApiOperation({ summary: "Withdraw a person from a kiosk" })
  @ApiOkResponse({ type: EnrollmentView })
  @ApiParam({ name: "deviceId", description: "Kiosk id", example: "kiosk-2884859fd3c8" })
  @ApiParam({ name: "employeeId", description: "Employee id", example: 42 })
  revoke(
    @CurrentViewer() viewer: Viewer,
    @Param("deviceId") deviceId: string,
    @Param("employeeId", ParseIntPipe) employeeId: number,
  ): Promise<DeviceEnrollment> {
    return this.enrollment.revoke(viewer, deviceId, employeeId);
  }

  @Post(":deviceId/resync")
  @RateBucket(THROTTLE.heavy)
  @Roles("ADMIN")
  @ApiOperation({ summary: "Send the kiosk the whole roster it should hold" })
  @ApiCreatedResponse({ type: RosterView })
  @ApiConflictResponse({ type: ErrorBody, description: "DEVICE_NOT_APPROVED: the kiosk is waiting or revoked" })
  @ApiParam({ name: "deviceId", description: "Kiosk id", example: "kiosk-2884859fd3c8" })
  async resync(@Param("deviceId") deviceId: string): Promise<{ rosterVersion: number }> {
    return { rosterVersion: await this.enrollment.resync(deviceId) };
  }
}
