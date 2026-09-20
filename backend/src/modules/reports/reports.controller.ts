import { Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import { Roles } from "../../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { RangeDto } from "./dto/report.dto.js";
import { ReportsService, type AttendanceTally, type Attention } from "./reports.service.js";

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

  @Get("attendance")
  @ApiOperation({ summary: "Punches per employee in a range, served from cache" })
  summary(@Query() range: RangeDto): Promise<AttendanceTally[]> {
    return this.reports.summary(new Date(range.from), new Date(range.to));
  }

  @Post("attendance/monthly")
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Queue a long roll-up; asking twice queues one run" })
  async schedule(@Body() range: RangeDto): Promise<{ jobId: string }> {
    return { jobId: await this.reports.schedule({ type: "monthly", ...range }) };
  }
}
