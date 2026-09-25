import { Body, Controller, Get, Header, HttpStatus, Post, Query, UseGuards } from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from "@nestjs/swagger";

import { ApiErrors } from "../../common/decorators/api-docs.decorator.js";
import { RateBucket } from "../../common/decorators/rate-bucket.decorator.js";
import { Roles } from "../../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { CurrentViewer, type Viewer } from "../../common/scope/viewer.js";
import type { Page } from "../../common/dto/pagination.dto.js";
import { THROTTLE } from "../auth/auth.types.js";
import {
  AttendanceTallyPage,
  D02QueryDto,
  InsuranceRangeDto,
  RangeDto,
  ReportQueued,
  TallyRangeDto,
  TallyTotalsView,
  TeamTodayView,
  TodayCountsView,
} from "./dto/report.dto.js";
import {
  ReportsService,
  type AttendanceTally,
  type Attention,
  type InsuranceChanges,
  type TallyTotals,
  type TeamToday,
  type TodayCounts,
} from "./reports.service.js";

@ApiTags("reports")
@ApiBearerAuth()
@ApiErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("reports")
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get("attention")
  @Roles("ADMIN", "HR", "PAYROLL")
  @ApiOperation({ summary: "What needs a decision today (KEHOACH 9.18)" })
  attention(): Promise<Attention> {
    return this.reports.attention();
  }

  @Get("today")
  @Roles("ADMIN", "HR", "PAYROLL", "MANAGER")
  @ApiOperation({ summary: "Today's expected, present, late, absent and on-leave counts in the viewer's reach" })
  @ApiOkResponse({ type: TodayCountsView })
  today(@CurrentViewer() viewer: Viewer): Promise<TodayCounts> {
    return this.reports.today(viewer);
  }

  @Get("team-today")
  @Roles("ADMIN", "HR", "PAYROLL", "MANAGER")
  @ApiOperation({ summary: "Who in the viewer's reach is absent, on leave or not punched yet" })
  @ApiOkResponse({ type: TeamTodayView })
  teamToday(@CurrentViewer() viewer: Viewer): Promise<TeamToday> {
    return this.reports.teamToday(viewer);
  }

  @Get("d02-lt")
  @RateBucket(THROTTLE.heavy)
  @Roles("ADMIN", "HR", "PAYROLL")
  @Header("Content-Type", "text/csv; charset=utf-8")
  @ApiProduces("text/csv")
  @ApiOkResponse({ description: "CSV with a byte order mark, columns in form order", schema: { type: "string" } })
  @ApiOperation({ summary: "The roster that fills D02-LT for one legal entity" })
  d02(@Query() query: D02QueryDto): Promise<string> {
    return this.reports.d02(query.legalEntityId, new Date(query.on));
  }

  @Get("insurance-changes")
  @Roles("ADMIN", "HR", "PAYROLL")
  @ApiOperation({ summary: "Who started, who stopped, whose base moved" })
  insuranceChanges(@Query() query: InsuranceRangeDto): Promise<InsuranceChanges> {
    return this.reports.insuranceChanges(
      query.legalEntityId,
      new Date(query.from),
      new Date(query.to),
    );
  }

  @Get("attendance")
  @Roles("ADMIN", "HR", "PAYROLL", "MANAGER")
  @ApiOperation({ summary: "Punches per employee in a range; a finished range is served from cache" })
  @ApiOkResponse({ type: AttendanceTallyPage })
  summary(
    @CurrentViewer() viewer: Viewer,
    @Query() range: TallyRangeDto,
  ): Promise<Page<AttendanceTally>> {
    return this.reports.summary(viewer, new Date(range.from), new Date(range.to), range);
  }

  @Get("attendance/totals")
  @Roles("ADMIN", "HR", "PAYROLL", "MANAGER")
  @ApiOperation({ summary: "The roll-up summed over everybody the range and the filters reach" })
  @ApiOkResponse({ type: TallyTotalsView })
  tallyTotals(@CurrentViewer() viewer: Viewer, @Query() range: TallyRangeDto): Promise<TallyTotals> {
    return this.reports.tallyTotals(viewer, new Date(range.from), new Date(range.to), range);
  }

  @Post("attendance/monthly")
  @RateBucket(THROTTLE.heavy)
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Queue a long roll-up; asking while one waits queues nothing more" })
  @ApiCreatedResponse({ type: ReportQueued })
  async schedule(@Body() range: RangeDto): Promise<{ jobId: string }> {
    return { jobId: await this.reports.schedule({ type: "monthly", ...range }) };
  }
}
