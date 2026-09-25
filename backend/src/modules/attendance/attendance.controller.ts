import { Controller, Get, HttpStatus, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { AttendanceRecord } from "@prisma/client";

import { ApiErrors } from "../../common/decorators/api-docs.decorator.js";
import type { Page } from "../../common/dto/pagination.dto.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { CurrentViewer, type Viewer } from "../../common/scope/viewer.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { AttendanceService, type PunchCounts } from "./attendance.service.js";
import { ListAttendanceDto, PunchCountsView, PunchPageView } from "./dto/attendance.dto.js";

@ApiTags("attendance")
@ApiBearerAuth()
@ApiErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED)
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("attendance")
export class AttendanceController {
  constructor(private readonly attendance: AttendanceService) {}

  @Get()
  @ApiOperation({ summary: "The punches themselves, which the roll-up only counts" })
  @ApiOkResponse({ type: PunchPageView })
  list(
    @Query() query: ListAttendanceDto,
    @CurrentViewer() viewer: Viewer,
  ): Promise<Page<AttendanceRecord>> {
    return this.attendance.list(query, viewer);
  }

  @Get("counts")
  @ApiOperation({ summary: "How many punches the range holds, and how many were offline or clock-unsynced" })
  @ApiOkResponse({ type: PunchCountsView })
  counts(@Query() query: ListAttendanceDto, @CurrentViewer() viewer: Viewer): Promise<PunchCounts> {
    return this.attendance.counts(query, viewer);
  }
}
