import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { AttendanceRecord } from "@prisma/client";

import type { Page } from "../../common/dto/pagination.dto.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { CurrentViewer, type Viewer } from "../../common/scope/viewer.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { AttendanceService } from "./attendance.service.js";
import { ListAttendanceDto } from "./dto/attendance.dto.js";

@ApiTags("attendance")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("attendance")
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  @Get()
  @ApiOperation({ summary: "The punches themselves, which the roll-up only counts" })
  list(
    @Query() query: ListAttendanceDto,
    @CurrentViewer() viewer: Viewer,
  ): Promise<Page<AttendanceRecord>> {
    return this.attendance.list(query, viewer);
  }
}
