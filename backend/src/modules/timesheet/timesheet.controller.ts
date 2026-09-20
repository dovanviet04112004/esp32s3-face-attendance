import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { AttendanceDay } from "@prisma/client";

import { Roles } from "../../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { CurrentViewer, type Viewer } from "../../common/scope/viewer.js";
import { BuildDaysDto, CorrectDayDto, ListDaysDto } from "./dto/timesheet.dto.js";
import { TimesheetService, type BuildReport, type DaySummary } from "./timesheet.service.js";

@ApiTags("timesheet")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("timesheet")
export class TimesheetController {
  constructor(private readonly timesheet: TimesheetService) {}

  @Get()
  @ApiOperation({ summary: "Day rows this viewer may read (KEHOACH 9.8)" })
  list(@CurrentViewer() viewer: Viewer, @Query() query: ListDaysDto): Promise<AttendanceDay[]> {
    return this.timesheet.list(viewer, query);
  }

  @Get("summary")
  @ApiOperation({ summary: "One row per person for a range, totals only" })
  summary(@CurrentViewer() viewer: Viewer, @Query() query: ListDaysDto): Promise<DaySummary[]> {
    return this.timesheet.summary(viewer, query);
  }

  @Patch(":id")
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Correct a day by hand, leaving the measurement and a trace" })
  correct(
    @CurrentViewer() viewer: Viewer,
    @Param("id") id: string,
    @Body() body: CorrectDayDto,
  ): Promise<AttendanceDay> {
    return this.timesheet.correct(viewer, id, body);
  }

  @Post("build")
  @Roles("ADMIN", "HR", "PAYROLL")
  @ApiOperation({ summary: "Queue the fold from punches into days; asking twice queues twice" })
  build(@Body() body: BuildDaysDto): Promise<{ jobId: string }> {
    return this.timesheet.scheduleBuild(body.from, body.to);
  }
}
