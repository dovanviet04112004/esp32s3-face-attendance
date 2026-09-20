import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Payslip, PayrollPeriod, PayrollRun } from "@prisma/client";

import { Roles } from "../../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { CurrentViewer, type Viewer } from "../../common/scope/viewer.js";
import { CreatePeriodDto, CreateRunDto, LockPeriodDto } from "./dto/payroll.dto.js";
import {
  PayrollService,
  type ChecklistItem,
  type PayslipDelta,
  type PayslipDetail,
} from "./payroll.service.js";

@ApiTags("payroll")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller()
export class PayrollController {
  constructor(private readonly payroll: PayrollService) {}

  @Get("payroll-periods")
  @Roles("ADMIN", "HR", "PAYROLL")
  periods(@Query("legalEntityId") legalEntityId?: string): Promise<PayrollPeriod[]> {
    return this.payroll.periods(legalEntityId);
  }

  @Post("payroll-periods")
  @Roles("ADMIN", "PAYROLL")
  createPeriod(
    @CurrentViewer() viewer: Viewer,
    @Body() body: CreatePeriodDto,
  ): Promise<PayrollPeriod> {
    return this.payroll.createPeriod(viewer, body);
  }

  @Get("payroll-periods/:id/checklist")
  @Roles("ADMIN", "HR", "PAYROLL")
  @ApiOperation({ summary: "What is still unsettled in this period (KEHOACH 9.18)" })
  checklist(@Param("id") id: string): Promise<ChecklistItem[]> {
    return this.payroll.checklist(id);
  }

  @Post("payroll-periods/:id/lock")
  @Roles("ADMIN", "PAYROLL")
  @ApiOperation({ summary: "Freeze the inputs and issue the drafts (KEHOACH 9.6)" })
  lock(
    @CurrentViewer() viewer: Viewer,
    @Param("id") id: string,
    @Body() body: LockPeriodDto,
  ): Promise<PayrollPeriod> {
    return this.payroll.lock(viewer, id, body);
  }

  @Post("payroll-periods/:id/paid")
  @Roles("ADMIN", "PAYROLL")
  markPaid(@CurrentViewer() viewer: Viewer, @Param("id") id: string): Promise<PayrollPeriod> {
    return this.payroll.markPaid(viewer, id);
  }

  @Get("payroll-periods/:id/runs")
  @Roles("ADMIN", "HR", "PAYROLL")
  runs(@Param("id") id: string): Promise<PayrollRun[]> {
    return this.payroll.runs(id);
  }

  @Post("payroll-runs")
  @Roles("ADMIN", "PAYROLL")
  createRun(@CurrentViewer() viewer: Viewer, @Body() body: CreateRunDto): Promise<PayrollRun> {
    return this.payroll.createRun(viewer, body);
  }

  @Post("payroll-runs/:id/execute")
  @Roles("ADMIN", "PAYROLL")
  @ApiOperation({ summary: "Calculate every payslip in the run" })
  execute(@CurrentViewer() viewer: Viewer, @Param("id") id: string): Promise<PayrollRun> {
    return this.payroll.execute(viewer, id);
  }

  @Get("payslips")
  @ApiOperation({ summary: "Payslips this viewer may read, narrowed by their scope" })
  payslips(
    @CurrentViewer() viewer: Viewer,
    @Query("periodId") periodId?: string,
    @Query("runId") runId?: string,
  ): Promise<Payslip[]> {
    return this.payroll.payslips(viewer, periodId, runId);
  }

  @Get("payslips/:id")
  payslip(@CurrentViewer() viewer: Viewer, @Param("id") id: string): Promise<PayslipDetail> {
    return this.payroll.payslip(viewer, id);
  }

  @Get("payslips/:id/compare")
  @ApiOperation({ summary: "Component by component against the month before" })
  compare(@CurrentViewer() viewer: Viewer, @Param("id") id: string): Promise<PayslipDelta[]> {
    return this.payroll.compare(viewer, id);
  }
}
