import { Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { AttendanceDay } from "@prisma/client";

import { Roles } from "../../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { CurrentViewer, type Viewer } from "../../common/scope/viewer.js";
import { BuildDaysDto, ListDaysDto } from "./dto/timesheet.dto.js";
import { TimesheetService, type BuildReport } from "./timesheet.service.js";

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

  @Post("build")
  @Roles("ADMIN", "HR", "PAYROLL")
  @ApiOperation({ summary: "Fold punches into days for a finished range" })
  build(@Body() body: BuildDaysDto): Promise<BuildReport> {
    return this.timesheet.buildRange(body.from, body.to);
  }
}
