import { Body, Controller, Get, HttpStatus, Param, Post, Query, UseGuards } from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";
import type { AttendanceRecord } from "@prisma/client";

import { ApiErrors } from "../../common/decorators/api-docs.decorator.js";
import { AuditedInService } from "../../common/decorators/audited.decorator.js";
import { RateBucket } from "../../common/decorators/rate-bucket.decorator.js";
import { ErrorBody } from "../../common/dto/error-body.dto.js";
import type { Page } from "../../common/dto/pagination.dto.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { CurrentViewer, type Viewer } from "../../common/scope/viewer.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { THROTTLE } from "../auth/auth.types.js";
import { AttendanceService, type DecidePunchesResult, type HeldPunch, type PunchCounts } from "./attendance.service.js";
import {
  DecidePunchDto,
  DecidePunchesDto,
  DecidePunchesView,
  HeldPageView,
  ListAttendanceDto,
  ListHeldDto,
  PunchCountsView,
  PunchPageView,
  PunchView,
} from "./dto/attendance.dto.js";

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
  @ApiOperation({ summary: "How many punches the range holds, and how many were offline, clock-unsynced or questionable" })
  @ApiOkResponse({ type: PunchCountsView })
  counts(@Query() query: ListAttendanceDto, @CurrentViewer() viewer: Viewer): Promise<PunchCounts> {
    return this.attendance.counts(query, viewer);
  }

  @Get("held")
  @ApiOperation({ summary: "Punches held for review that wait on this viewer, oldest receipt first by default" })
  @ApiOkResponse({ type: HeldPageView })
  held(@Query() query: ListHeldDto, @CurrentViewer() viewer: Viewer): Promise<Page<HeldPunch>> {
    return this.attendance.held(viewer, query);
  }

  @Post("held/decide-many")
  @RateBucket(THROTTLE.heavy)
  @AuditedInService()
  @ApiOperation({ summary: "Decide up to 100 held punches at once; each goes through the single-decision rules" })
  @ApiCreatedResponse({ type: DecidePunchesView })
  @ApiBadRequestResponse({ type: ErrorBody, description: "DECISION_NOTE_REQUIRED when turning down" })
  decideMany(@CurrentViewer() viewer: Viewer, @Body() body: DecidePunchesDto): Promise<DecidePunchesResult> {
    return this.attendance.decideMany(viewer, body);
  }

  @Post("held/:id/decide")
  @AuditedInService()
  @ApiOperation({ summary: "Let one held punch count, or turn it down for good" })
  @ApiCreatedResponse({ type: PunchView })
  @ApiBadRequestResponse({ type: ErrorBody, description: "DECISION_NOTE_REQUIRED when turning down" })
  @ApiForbiddenResponse({ type: ErrorBody, description: "HR_ONLY, SELF_DECISION, DESK_NEEDS_EMPLOYEE" })
  @ApiConflictResponse({ type: ErrorBody, description: "PUNCH_ALREADY_DECIDED" })
  @ApiNotFoundResponse({ type: ErrorBody, description: "PUNCH_NOT_FOUND, also for a punch that was never held" })
  @ApiParam({ name: "id", description: "Punch id, a decimal string", example: "1842" })
  decide(
    @CurrentViewer() viewer: Viewer,
    @Param("id") id: string,
    @Body() body: DecidePunchDto,
  ): Promise<AttendanceRecord> {
    return this.attendance.decide(viewer, id, body.approve, body.note);
  }
}
