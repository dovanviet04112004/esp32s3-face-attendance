import {
  Body,
  Controller,
  Get,
  Header,
  HttpStatus,
  Param,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from "@nestjs/swagger";
import type { PayrollPeriod, PayrollRun } from "@prisma/client";

import { ApiErrors } from "../../common/decorators/api-docs.decorator.js";
import { AuditedInService } from "../../common/decorators/audited.decorator.js";
import { RateBucket } from "../../common/decorators/rate-bucket.decorator.js";
import { Roles } from "../../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { CurrentViewer, type Viewer } from "../../common/scope/viewer.js";
import type { Page } from "../../common/dto/pagination.dto.js";
import { THROTTLE } from "../auth/auth.types.js";
import {
  AddBonusDto,
  ChecklistItemView,
  CreatePeriodDto,
  CreateRunDto,
  DeliveryView,
  ExportQueryDto,
  ItemCount,
  ListPayslipsDto,
  LockPeriodDto,
  PayslipPageView,
  PeriodTotalsView,
  PeriodView,
  PeriodsQueryDto,
  QueuedCount,
  RunView,
  SetSettlementDto,
  TaxYearQueryDto,
} from "./dto/payroll.dto.js";
import {
  PayrollService,
  type ChecklistItem,
  type PayslipDelta,
  type PayslipDetail,
  type BonusRow,
  type Delivery,
  type PayslipRow,
  type PeriodTotals,
  type SettlementSheet,
  type TaxYearStatement,
} from "./payroll.service.js";

@ApiTags("payroll")
@ApiBearerAuth()
@ApiErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND)
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller()
export class PayrollController {
  constructor(private readonly payroll: PayrollService) {}

  @Get("payroll-periods")
  @Roles("ADMIN", "HR", "PAYROLL")
  @ApiOperation({ summary: "Every pay month and the state it is in" })
  @ApiOkResponse({ type: [PeriodView] })
  periods(@Query() query: PeriodsQueryDto): Promise<PayrollPeriod[]> {
    return this.payroll.periods(query.legalEntityId);
  }

  @Post("payroll-periods")
  @Roles("ADMIN", "PAYROLL")
  @ApiOperation({ summary: "Open a pay month; one per entity and month, company-wide counting as one" })
  @ApiCreatedResponse({ type: PeriodView })
  @ApiErrors(HttpStatus.CONFLICT)
  createPeriod(
    @CurrentViewer() viewer: Viewer,
    @Body() body: CreatePeriodDto,
  ): Promise<PayrollPeriod> {
    return this.payroll.createPeriod(viewer, body);
  }

  @Get("payroll-periods/:id/checklist")
  @Roles("ADMIN", "HR", "PAYROLL")
  @ApiOperation({ summary: "What is still unsettled in this period (KEHOACH 9.18)" })
  @ApiOkResponse({ type: [ChecklistItemView] })
  checklist(@Param("id") id: string): Promise<ChecklistItem[]> {
    return this.payroll.checklist(id);
  }

  @Post("payroll-periods/:id/lock")
  @AuditedInService()
  @Roles("ADMIN", "PAYROLL")
  @ApiOperation({
    summary: "Freeze the inputs and issue the newest finished run per person; refused while a run is going",
  })
  @ApiCreatedResponse({ type: PeriodView })
  @ApiErrors(HttpStatus.CONFLICT)
  lock(
    @CurrentViewer() viewer: Viewer,
    @Param("id") id: string,
    @Body() body: LockPeriodDto,
  ): Promise<PayrollPeriod> {
    return this.payroll.lock(viewer, id, body);
  }

  @Post("payroll-periods/:id/paid")
  @AuditedInService()
  @Roles("ADMIN", "PAYROLL")
  @ApiOperation({ summary: "Mark a locked period paid" })
  @ApiCreatedResponse({ type: PeriodView })
  markPaid(@CurrentViewer() viewer: Viewer, @Param("id") id: string): Promise<PayrollPeriod> {
    return this.payroll.markPaid(viewer, id);
  }

  @Get("payroll-periods/:id/totals")
  @Roles("ADMIN", "HR", "PAYROLL")
  @ApiOperation({ summary: "Headcount, gross, net and employer cost over what the period issues or will issue" })
  @ApiOkResponse({ type: PeriodTotalsView })
  totals(@Param("id") id: string): Promise<PeriodTotals> {
    return this.payroll.periodTotals(id);
  }

  @Get("payroll-periods/:id/delivery")
  @Roles("ADMIN", "HR", "PAYROLL")
  @ApiOperation({ summary: "How many issued payslips have gone out to their owners" })
  @ApiOkResponse({ type: DeliveryView })
  delivery(@Param("id") id: string): Promise<Delivery> {
    return this.payroll.delivery(id);
  }

  @Post("payroll-periods/:id/deliver")
  @AuditedInService()
  @RateBucket(THROTTLE.heavy)
  @Roles("ADMIN", "PAYROLL")
  @ApiOperation({ summary: "Send every issued payslip as a link, not an attachment" })
  @ApiCreatedResponse({ type: QueuedCount })
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
  @ApiProduces("text/csv")
  @ApiOperation({ summary: "The payment file for a bank, or the ledger for accounting" })
  @ApiOkResponse({ description: "CSV; the ledger carries a byte order mark for Excel", schema: { type: "string" } })
  exportRows(
    @CurrentViewer() viewer: Viewer,
    @Param("id") id: string,
    @Query() query: ExportQueryDto,
  ): Promise<string> {
    return this.payroll.exportRows(viewer, id, query.kind ?? "bank");
  }

  @Get("payroll-periods/:id/runs")
  @Roles("ADMIN", "HR", "PAYROLL")
  @ApiOperation({ summary: "Every attempt at calculating this period" })
  @ApiOkResponse({ type: [RunView] })
  runs(@Param("id") id: string): Promise<PayrollRun[]> {
    return this.payroll.runs(id);
  }

  @Post("payroll-runs")
  @RateBucket(THROTTLE.heavy)
  @Roles("ADMIN", "PAYROLL")
  @ApiOperation({ summary: "Start a run: regular, bonus or final settlement" })
  @ApiCreatedResponse({ type: RunView })
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
  @AuditedInService()
  @Roles("ADMIN", "PAYROLL")
  @ApiOperation({ summary: "Load the amounts a bonus run pays; nobody loads their own (SELF_DECISION)" })
  @ApiCreatedResponse({ type: ItemCount })
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
  @AuditedInService()
  @Roles("ADMIN", "PAYROLL")
  @ApiOperation({ summary: "Load the severance and offsets somebody signed for" })
  @ApiCreatedResponse({ type: ItemCount })
  setSettlement(
    @CurrentViewer() viewer: Viewer,
    @Param("id") id: string,
    @Body() body: SetSettlementDto,
  ): Promise<{ items: number }> {
    return this.payroll.setSettlement(viewer, id, body.items);
  }

  @Post("payroll-runs/:id/execute")
  @AuditedInService()
  @RateBucket(THROTTLE.heavy)
  @Roles("ADMIN", "PAYROLL")
  @ApiOperation({ summary: "Claim the run as RUNNING and queue it; a second press is refused" })
  @ApiCreatedResponse({ type: RunView })
  execute(@CurrentViewer() viewer: Viewer, @Param("id") id: string): Promise<PayrollRun> {
    return this.payroll.execute(viewer, id);
  }

  @Get("tax-year/:employeeId")
  @ApiOperation({ summary: "A year of income and tax withheld, read back from the payslips" })
  taxYear(
    @CurrentViewer() viewer: Viewer,
    @Param("employeeId", ParseIntPipe) employeeId: number,
    @Query() query: TaxYearQueryDto,
  ): Promise<TaxYearStatement> {
    return this.payroll.taxYear(viewer, employeeId, query.year);
  }

  @Get("payslips")
  @ApiOperation({ summary: "Payslips this viewer may read; nobody but the desk reads a draft" })
  @ApiOkResponse({ type: PayslipPageView })
  payslips(
    @CurrentViewer() viewer: Viewer,
    @Query() query: ListPayslipsDto,
  ): Promise<Page<PayslipRow>> {
    return this.payroll.payslips(viewer, query);
  }

  @Get("payslips/export")
  @RateBucket(THROTTLE.heavy)
  @Roles("ADMIN", "HR", "PAYROLL")
  @Header("Content-Type", "text/csv; charset=utf-8")
  @ApiProduces("text/csv")
  @ApiOperation({ summary: "Every payslip the list filter reaches, as a file Excel opens" })
  @ApiOkResponse({ description: "CSV with a byte order mark", schema: { type: "string" } })
  payslipsCsv(@CurrentViewer() viewer: Viewer, @Query() query: ListPayslipsDto): Promise<string> {
    return this.payroll.payslipsCsv(viewer, query);
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
