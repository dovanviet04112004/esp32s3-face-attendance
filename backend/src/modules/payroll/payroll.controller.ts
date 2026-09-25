import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { PayrollPeriod, PayrollRun } from "@prisma/client";

import { RateBucket } from "../../common/decorators/rate-bucket.decorator.js";
import { Roles } from "../../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { CurrentViewer, type Viewer } from "../../common/scope/viewer.js";
import type { Page } from "../../common/dto/pagination.dto.js";
import { THROTTLE } from "../auth/auth.types.js";
import {
  AddBonusDto,
  CreatePeriodDto,
  CreateRunDto,
  ListPayslipsDto,
  LockPeriodDto,
  SetSettlementDto,
} from "./dto/payroll.dto.js";
import {
  PayrollService,
  type ChecklistItem,
  type PayslipDelta,
  type PayslipDetail,
  type BonusRow,
  type Delivery,
  type PayslipRow,
  type ExportKind,
  type SettlementSheet,
  type TaxYearStatement,
} from "./payroll.service.js";

@ApiTags("payroll")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller()
export class PayrollController {
  constructor(private readonly payroll: PayrollService) {}

  @Get("payroll-periods")
  @Roles("ADMIN", "HR", "PAYROLL")
  @ApiOperation({ summary: "Every pay month and the state it is in" })
  periods(@Query("legalEntityId") legalEntityId?: string): Promise<PayrollPeriod[]> {
    return this.payroll.periods(legalEntityId);
  }

  @Post("payroll-periods")
  @Roles("ADMIN", "PAYROLL")
  @ApiOperation({ summary: "Open a pay month" })
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
  @ApiOperation({ summary: "Mark a locked period paid" })
  markPaid(@CurrentViewer() viewer: Viewer, @Param("id") id: string): Promise<PayrollPeriod> {
    return this.payroll.markPaid(viewer, id);
  }

  @Get("payroll-periods/:id/delivery")
  @Roles("ADMIN", "HR", "PAYROLL")
  @ApiOperation({ summary: "How many issued payslips have gone out to their owners" })
  delivery(@Param("id") id: string): Promise<Delivery> {
    return this.payroll.delivery(id);
  }

  @Post("payroll-periods/:id/deliver")
  @RateBucket(THROTTLE.heavy)
  @Roles("ADMIN", "PAYROLL")
  @ApiOperation({ summary: "Send every issued payslip as a link, not an attachment" })
  deliver(
    @CurrentViewer() viewer: Viewer,
    @Param("id") id: string,
  ): Promise<{ queued: number }> {
    return this.payroll.deliver(viewer, id);
  }

  @Get("payroll-periods/:id/export")
  @RateBucket(THROTTLE.heavy)
  @Roles("ADMIN", "PAYROLL")
  @Header("Content-Type", "text/csv; charset=utf-8")
  @ApiOperation({ summary: "The payment file for a bank, or the one for accounting" })
  exportRows(
    @CurrentViewer() viewer: Viewer,
    @Param("id") id: string,
    @Query("kind") kind?: string,
  ): Promise<string> {
    const wanted: ExportKind = kind === "ledger" ? "ledger" : "bank";
    return this.payroll.exportRows(viewer, id, wanted);
  }

  @Get("payroll-periods/:id/runs")
  @Roles("ADMIN", "HR", "PAYROLL")
  @ApiOperation({ summary: "Every attempt at calculating this period" })
  runs(@Param("id") id: string): Promise<PayrollRun[]> {
    return this.payroll.runs(id);
  }

  @Post("payroll-runs")
  @RateBucket(THROTTLE.heavy)
  @Roles("ADMIN", "PAYROLL")
  @ApiOperation({ summary: "Start a run: regular, bonus or final settlement" })
  createRun(@CurrentViewer() viewer: Viewer, @Body() body: CreateRunDto): Promise<PayrollRun> {
    return this.payroll.createRun(viewer, body);
  }

  @Get("payroll-runs/:id/bonus")
  @Roles("ADMIN", "PAYROLL")
  @ApiOperation({ summary: "The amounts a bonus run holds, as loaded" })
  bonus(@CurrentViewer() viewer: Viewer, @Param("id") id: string): Promise<BonusRow[]> {
    return this.payroll.bonus(viewer, id);
  }

  @Post("payroll-runs/:id/bonus")
  @Roles("ADMIN", "PAYROLL")
  @ApiOperation({ summary: "Load the amounts a bonus run pays; running uses them" })
  setBonus(
    @CurrentViewer() viewer: Viewer,
    @Param("id") id: string,
    @Body() body: AddBonusDto,
  ): Promise<{ items: number }> {
    return this.payroll.setBonus(viewer, id, body.items);
  }

  @Get("payroll-runs/:id/settlement")
  @Roles("ADMIN", "PAYROLL")
  @ApiOperation({ summary: "Everything a leaver is owed that the system can derive" })
  settlementSheet(
    @CurrentViewer() viewer: Viewer,
    @Param("id") id: string,
  ): Promise<SettlementSheet> {
    return this.payroll.settlementSheet(viewer, id);
  }

  @Post("payroll-runs/:id/settlement")
  @Roles("ADMIN", "PAYROLL")
  @ApiOperation({ summary: "Load the severance and offsets somebody signed for" })
  setSettlement(
    @CurrentViewer() viewer: Viewer,
    @Param("id") id: string,
    @Body() body: SetSettlementDto,
  ): Promise<{ items: number }> {
    return this.payroll.setSettlement(viewer, id, body.items);
  }

  @Post("payroll-runs/:id/execute")
  @RateBucket(THROTTLE.heavy)
  @Roles("ADMIN", "PAYROLL")
  @ApiOperation({ summary: "Calculate every payslip in the run" })
  execute(@CurrentViewer() viewer: Viewer, @Param("id") id: string): Promise<PayrollRun> {
    return this.payroll.execute(viewer, id);
  }

  @Get("tax-year/:employeeId")
  @ApiOperation({ summary: "A year of income and tax withheld, read back from the payslips" })
  taxYear(
    @CurrentViewer() viewer: Viewer,
    @Param("employeeId", ParseIntPipe) employeeId: number,
    @Query("year", ParseIntPipe) year: number,
  ): Promise<TaxYearStatement> {
    return this.payroll.taxYear(viewer, employeeId, year);
  }

  @Get("payslips")
  @ApiOperation({ summary: "Payslips this viewer may read, narrowed by their scope" })
  payslips(
    @CurrentViewer() viewer: Viewer,
    @Query() query: ListPayslipsDto,
  ): Promise<Page<PayslipRow>> {
    return this.payroll.payslips(viewer, query);
  }

  @Get("payslips/:id")
  @ApiOperation({ summary: "One payslip with every line that makes it up" })
  payslip(@CurrentViewer() viewer: Viewer, @Param("id") id: string): Promise<PayslipDetail> {
    return this.payroll.payslip(viewer, id);
  }

  @Get("payslips/:id/compare")
  @ApiOperation({ summary: "Component by component against the month before" })
  compare(@CurrentViewer() viewer: Viewer, @Param("id") id: string): Promise<PayslipDelta[]> {
    return this.payroll.compare(viewer, id);
  }
}
