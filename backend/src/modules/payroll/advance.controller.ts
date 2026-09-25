import { Body, Controller, Get, HttpStatus, Param, Post, Query, UseGuards } from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import type { SalaryAdvance } from "@prisma/client";

import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import type { Page } from "../../common/dto/pagination.dto.js";
import { CurrentViewer, type Viewer } from "../../common/scope/viewer.js";
import { API_AUTH, ApiErrors } from "../../common/decorators/api-docs.decorator.js";
import { AuditedInService } from "../../common/decorators/audited.decorator.js";
import { ErrorBody } from "../../common/dto/error-body.dto.js";
import { AdvanceService, type AdvanceRow } from "./advance.service.js";
import {
  AdvancePageView,
  AdvanceView,
  DecideAdvanceDto,
  ListAdvancesDto,
  RequestAdvanceDto,
} from "./dto/advance.dto.js";

@ApiTags("advances")
@ApiBearerAuth(API_AUTH.user)
@ApiErrors(HttpStatus.UNAUTHORIZED)
@ApiBadRequestResponse({ type: ErrorBody, description: "A field or cursor the server refuses" })
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("advances")
export class AdvanceController {
  constructor(private readonly advances: AdvanceService) {}

  @Get()
  @ApiOperation({ summary: "Advances this viewer may see: the desk sees all but its own waiting rows, others their own" })
  @ApiOkResponse({ type: AdvancePageView })
  list(
    @CurrentViewer() viewer: Viewer,
    @Query() query: ListAdvancesDto,
  ): Promise<Page<AdvanceRow>> {
    return this.advances.list(viewer, query);
  }

  @Post()
  @ApiOperation({ summary: "Ask for an advance against next month's pay" })
  @ApiCreatedResponse({ type: AdvanceView })
  @ApiNotFoundResponse({ type: ErrorBody, description: "EMPLOYEE_NOT_FOUND: the login has no employee record" })
  submit(@CurrentViewer() viewer: Viewer, @Body() body: RequestAdvanceDto): Promise<SalaryAdvance> {
    return this.advances.submit(viewer, body);
  }

  @Post(":id/decide")
  @AuditedInService()
  @ApiOperation({ summary: "Approve or turn down; paying is a separate step" })
  @ApiCreatedResponse({ type: AdvanceView })
  @ApiForbiddenResponse({ type: ErrorBody, description: "ADVANCE_DECIDE_DENIED, SELF_DECISION" })
  @ApiBadRequestResponse({ type: ErrorBody, description: "ADVANCE_ALREADY_DECIDED" })
  @ApiNotFoundResponse({ type: ErrorBody, description: "ADVANCE_NOT_FOUND" })
  decide(
    @CurrentViewer() viewer: Viewer,
    @Param("id") id: string,
    @Body() body: DecideAdvanceDto,
  ): Promise<SalaryAdvance> {
    return this.advances.decide(viewer, id, body);
  }

  @Post(":id/paid")
  @AuditedInService()
  @ApiOperation({ summary: "Record that the money went out; payroll deducts it next" })
  @ApiCreatedResponse({ type: AdvanceView })
  @ApiForbiddenResponse({ type: ErrorBody, description: "ADVANCE_PAY_DENIED, SELF_DECISION" })
  @ApiBadRequestResponse({ type: ErrorBody, description: "ADVANCE_NOT_APPROVED" })
  @ApiNotFoundResponse({ type: ErrorBody, description: "ADVANCE_NOT_FOUND" })
  markPaid(@CurrentViewer() viewer: Viewer, @Param("id") id: string): Promise<SalaryAdvance> {
    return this.advances.markPaid(viewer, id);
  }

  @Post(":id/cancel")
  @ApiOperation({ summary: "Withdraw one's own request while it still waits" })
  @ApiCreatedResponse({ type: AdvanceView })
  @ApiBadRequestResponse({ type: ErrorBody, description: "ADVANCE_ALREADY_DECIDED" })
  @ApiNotFoundResponse({ type: ErrorBody, description: "ADVANCE_NOT_FOUND" })
  cancel(@CurrentViewer() viewer: Viewer, @Param("id") id: string): Promise<SalaryAdvance> {
    return this.advances.cancel(viewer, id);
  }
}
