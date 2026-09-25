import { Body, Controller, Get, Header, HttpStatus, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from "@nestjs/swagger";
import type { AttendanceDay } from "@prisma/client";

import { ApiErrors } from "../../common/decorators/api-docs.decorator.js";
import { AuditedInService } from "../../common/decorators/audited.decorator.js";
import { RateBucket } from "../../common/decorators/rate-bucket.decorator.js";
import { Roles } from "../../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import type { Page } from "../../common/dto/pagination.dto.js";
import { CurrentViewer, type Viewer } from "../../common/scope/viewer.js";
import { THROTTLE } from "../auth/auth.types.js";
import {
  BuildDaysDto,
  BuildQueued,
  BuildStateView,
  CorrectDayDto,
  DaySummaryPage,
  DayTotalsView,
  DayView,
  ListDaysDto,
  MonthQueryDto,
  MonthTallyView,
  SummaryQueryDto,
} from "./dto/timesheet.dto.js";
import {
  TimesheetService,
  type BuildState,
  type DaySummary,
  type DayTotals,
  type MonthTally,
} from "./timesheet.service.js";

@ApiTags("timesheet")
@ApiBearerAuth()
@ApiErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("timesheet")
export class TimesheetController {
  constructor(private readonly timesheet: TimesheetService) {}

  @Get()
  @ApiOperation({ summary: "Day rows this viewer may read (KEHOACH 9.8)" })
  @ApiOkResponse({ type: [DayView] })
  list(@CurrentViewer() viewer: Viewer, @Query() query: ListDaysDto): Promise<AttendanceDay[]> {
    return this.timesheet.list(viewer, query);
  }

  @Get("mine")
  @ApiOperation({ summary: "The viewer's own month in counts, for the home page (KEHOACH 9.10)" })
  @ApiOkResponse({ type: MonthTallyView })
  @ApiErrors(HttpStatus.NOT_FOUND)
  mine(@CurrentViewer() viewer: Viewer, @Query() query: MonthQueryDto): Promise<MonthTally> {
    return this.timesheet.mine(viewer, query.month);
  }

  @Get("summary")
  @ApiOperation({ summary: "One row per person for a range, searchable, optionally exceptions only" })
  @ApiOkResponse({ type: DaySummaryPage })
  summary(@CurrentViewer() viewer: Viewer, @Query() query: SummaryQueryDto): Promise<Page<DaySummary>> {
    return this.timesheet.summary(viewer, query);
  }

  @Get("summary/export")
  @RateBucket(THROTTLE.heavy)
  @Header("Content-Type", "text/csv; charset=utf-8")
  @ApiProduces("text/csv")
  @ApiOperation({ summary: "Every row the summary filter reaches, as a file Excel opens" })
  @ApiOkResponse({ description: "CSV with a byte order mark", schema: { type: "string" } })
  summaryCsv(@CurrentViewer() viewer: Viewer, @Query() query: SummaryQueryDto): Promise<string> {
    return this.timesheet.summaryCsv(viewer, query);
  }

  @Get("totals")
  @ApiOperation({ summary: "The summary's figures summed over everybody the filter reaches" })
  @ApiOkResponse({ type: DayTotalsView })
  totals(@CurrentViewer() viewer: Viewer, @Query() query: SummaryQueryDto): Promise<DayTotals> {
    return this.timesheet.totals(viewer, query);
  }

  @Get("build/:jobId")
  @Roles("ADMIN", "HR", "PAYROLL")
  @ApiOperation({ summary: "Where a queued build stands, so a page stops waiting when it ends" })
  @ApiOkResponse({ type: BuildStateView })
  buildState(@Param("jobId") jobId: string): Promise<{ state: BuildState }> {
    return this.timesheet.buildState(jobId);
  }

  @Patch(":id")
  @AuditedInService()
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Correct somebody else's day by hand, leaving the measurement and a trace" })
  @ApiOkResponse({ type: DayView })
  @ApiErrors(HttpStatus.NOT_FOUND)
  correct(
    @CurrentViewer() viewer: Viewer,
    @Param("id") id: string,
    @Body() body: CorrectDayDto,
  ): Promise<AttendanceDay> {
    return this.timesheet.correct(viewer, id, body);
  }

  @Post("build")
  @RateBucket(THROTTLE.heavy)
  @Roles("ADMIN", "HR", "PAYROLL")
  @ApiOperation({ summary: "Queue the fold from punches into days; asking twice queues twice" })
  @ApiCreatedResponse({ type: BuildQueued })
  build(@Body() body: BuildDaysDto): Promise<{ jobId: string }> {
    return this.timesheet.scheduleBuild(body.from, body.to);
  }
}
