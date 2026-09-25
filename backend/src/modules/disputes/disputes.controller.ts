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
  ApiTags,
} from "@nestjs/swagger";
import type { PayslipDispute } from "@prisma/client";

import type { Page } from "../../common/dto/pagination.dto.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { CurrentViewer, type Viewer } from "../../common/scope/viewer.js";
import { API_AUTH, ApiErrors } from "../../common/decorators/api-docs.decorator.js";
import { AuditedInService } from "../../common/decorators/audited.decorator.js";
import { ErrorBody } from "../../common/dto/error-body.dto.js";
import { DisputesService, type DisputeRow } from "./disputes.service.js";
import {
  AnswerDisputeDto,
  DisputePageView,
  DisputeView,
  ListDisputesDto,
  RaiseDisputeDto,
} from "./dto/dispute.dto.js";

@ApiTags("payslip-disputes")
@ApiBearerAuth(API_AUTH.user)
@ApiErrors(HttpStatus.UNAUTHORIZED)
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("payslip-disputes")
export class DisputesController {
  constructor(private readonly disputes: DisputesService) {}

  @Post()
  @AuditedInService()
  @ApiOperation({ summary: "Dispute a figure on a payslip already sent out" })
  @ApiCreatedResponse({ type: DisputeView })
  @ApiBadRequestResponse({ type: ErrorBody, description: "PAYSLIP_NOT_ISSUED" })
  @ApiConflictResponse({ type: ErrorBody, description: "DISPUTE_ALREADY_OPEN" })
  @ApiNotFoundResponse({ type: ErrorBody, description: "PAYSLIP_NOT_FOUND" })
  @ApiForbiddenResponse({ type: ErrorBody, description: "NO_EMPLOYEE_RECORD" })
  raise(@Body() body: RaiseDisputeDto, @CurrentViewer() viewer: Viewer): Promise<PayslipDispute> {
    return this.disputes.raise(viewer, body);
  }

  @Get()
  @ApiOperation({ summary: "Disputes: the pay desk sees all but its own open rows, others their own" })
  @ApiOkResponse({ type: DisputePageView })
  @ApiBadRequestResponse({ type: ErrorBody, description: "A field or cursor the server refuses" })
  list(
    @Query() query: ListDisputesDto,
    @CurrentViewer() viewer: Viewer,
  ): Promise<Page<DisputeRow>> {
    return this.disputes.list(viewer, query);
  }

  @Post(":id/answer")
  @AuditedInService()
  @ApiOperation({ summary: "Answer one; upholding with an amount mints the adjustment" })
  @ApiCreatedResponse({ type: DisputeView })
  @ApiForbiddenResponse({ type: ErrorBody, description: "PAYROLL_WRITE_DENIED, SELF_DECISION" })
  @ApiBadRequestResponse({ type: ErrorBody, description: "DISPUTE_ALREADY_ANSWERED" })
  @ApiNotFoundResponse({ type: ErrorBody, description: "DISPUTE_NOT_FOUND" })
  answer(
    @Param("id") id: string,
    @Body() body: AnswerDisputeDto,
    @CurrentViewer() viewer: Viewer,
  ): Promise<PayslipDispute> {
    return this.disputes.answer(viewer, id, body);
  }

  @Post(":id/withdraw")
  @AuditedInService()
  @ApiOperation({ summary: "Take back a dispute nobody has answered yet" })
  @ApiCreatedResponse({ type: DisputeView })
  @ApiForbiddenResponse({ type: ErrorBody, description: "DISPUTE_NOT_YOURS" })
  @ApiBadRequestResponse({ type: ErrorBody, description: "DISPUTE_ALREADY_ANSWERED" })
  @ApiNotFoundResponse({ type: ErrorBody, description: "DISPUTE_NOT_FOUND" })
  withdraw(@Param("id") id: string, @CurrentViewer() viewer: Viewer): Promise<PayslipDispute> {
    return this.disputes.withdraw(viewer, id);
  }
}
