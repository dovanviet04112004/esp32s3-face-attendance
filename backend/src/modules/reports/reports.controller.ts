import { Body, Controller, Get, Header, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import { RateBucket } from "../../common/decorators/rate-bucket.decorator.js";
import { Roles } from "../../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { CurrentViewer, type Viewer } from "../../common/scope/viewer.js";
import type { Page } from "../../common/dto/pagination.dto.js";
import { THROTTLE } from "../auth/auth.types.js";
import {
  D02QueryDto,
  InsuranceRangeDto,
  RangeDto,
  TallyRangeDto,
} from "./dto/report.dto.js";
import {
  ReportsService,
  type AttendanceTally,
  type Attention,
  type InsuranceChanges,
  type TallyTotals,
} from "./reports.service.js";

@ApiTags("reports")
@ApiBearerAuth()
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

  @Get("d02-lt")
  @Roles("ADMIN", "HR", "PAYROLL")
  @Header("Content-Type", "text/csv; charset=utf-8")
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
  @ApiOperation({ summary: "Punches per employee in a range, served from cache" })
  summary(
    @CurrentViewer() viewer: Viewer,
    @Query() range: TallyRangeDto,
  ): Promise<Page<AttendanceTally>> {
    return this.reports.summary(viewer, new Date(range.from), new Date(range.to), range);
  }

  @Get("attendance/totals")
  @Roles("ADMIN", "HR", "PAYROLL", "MANAGER")
  @ApiOperation({ summary: "The roll-up summed over everybody the range and the search reach" })
  tallyTotals(@CurrentViewer() viewer: Viewer, @Query() range: TallyRangeDto): Promise<TallyTotals> {
    return this.reports.tallyTotals(viewer, new Date(range.from), new Date(range.to), range.search);
  }

  @Post("attendance/monthly")
  @RateBucket(THROTTLE.heavy)
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Queue a long roll-up; asking twice queues one run" })
  async schedule(@Body() range: RangeDto): Promise<{ jobId: string }> {
    return { jobId: await this.reports.schedule({ type: "monthly", ...range }) };
  }
}
