import { Body, Controller, Get, Header, HttpStatus, Param, Post, Query, UseGuards } from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiTags,
} from "@nestjs/swagger";
import type { SalaryAdvance } from "@prisma/client";

import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import type { Page } from "../../common/dto/pagination.dto.js";
import { Reach } from "../../common/scope/reach.js";
import { CurrentViewer, type Viewer } from "../../common/scope/viewer.js";
import { API_AUTH, ApiErrors } from "../../common/decorators/api-docs.decorator.js";
import { AuditedInService } from "../../common/decorators/audited.decorator.js";
import { RateBucket } from "../../common/decorators/rate-bucket.decorator.js";
import { Roles } from "../../common/decorators/roles.decorator.js";
import { ErrorBody } from "../../common/dto/error-body.dto.js";
import { THROTTLE } from "../auth/auth.types.js";
import { QUEUE_DESKS } from "../leave/queue-filter.js";
import { AdvanceService, type AdvanceRow } from "./advance.service.js";
import {
  AdvancePageView,
  AdvanceRowView,
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

  @Get("export")
  @RateBucket(THROTTLE.heavy)
  @Roles(...QUEUE_DESKS.advancesToDecide, ...QUEUE_DESKS.advancesToPay)
  @Reach("person")
  @Header("Content-Type", "text/csv; charset=utf-8")
  @ApiProduces("text/csv")
  @ApiOperation({ summary: "The advances list under the same filter, as a file Excel opens" })
  @ApiOkResponse({ description: "CSV with a byte order mark", schema: { type: "string" } })
  exportCsv(@CurrentViewer() viewer: Viewer, @Query() query: ListAdvancesDto): Promise<string> {
    return this.advances.exportCsv(viewer, query);
  }

  @Get(":id")
  @ApiOperation({ summary: "One advance, in the same scope as the list, with who decided it" })
  @ApiParam({ name: "id", description: "Advance id (UUID)", example: "ee5e4c9f-9f5c-4ebd-8759-9b7ac5ed3696" })
  @ApiOkResponse({ type: AdvanceRowView })
  @ApiNotFoundResponse({ type: ErrorBody, description: "ADVANCE_NOT_FOUND, also outside the viewer's scope" })
  one(@CurrentViewer() viewer: Viewer, @Param("id") id: string): Promise<AdvanceRow> {
    return this.advances.one(viewer, id);
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
  @ApiForbiddenResponse({ type: ErrorBody, description: "ADVANCE_DECIDE_DENIED, SELF_DECISION, DESK_NEEDS_EMPLOYEE" })
  @ApiConflictResponse({ type: ErrorBody, description: "ADVANCE_ALREADY_DECIDED" })
  @ApiNotFoundResponse({ type: ErrorBody, description: "ADVANCE_NOT_FOUND" })
  @ApiParam({ name: "id", description: "Advance id (UUID)", example: "ee5e4c9f-9f5c-4ebd-8759-9b7ac5ed3696" })
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
  @ApiForbiddenResponse({ type: ErrorBody, description: "ADVANCE_PAY_DENIED, SELF_DECISION, DESK_NEEDS_EMPLOYEE" })
  @ApiConflictResponse({ type: ErrorBody, description: "ADVANCE_NOT_APPROVED" })
  @ApiNotFoundResponse({ type: ErrorBody, description: "ADVANCE_NOT_FOUND" })
  @ApiParam({ name: "id", description: "Advance id (UUID)", example: "ee5e4c9f-9f5c-4ebd-8759-9b7ac5ed3696" })
  markPaid(@CurrentViewer() viewer: Viewer, @Param("id") id: string): Promise<SalaryAdvance> {
    return this.advances.markPaid(viewer, id);
  }

  @Post(":id/cancel")
  @ApiOperation({ summary: "Withdraw one's own request while it still waits" })
  @ApiCreatedResponse({ type: AdvanceView })
  @ApiConflictResponse({ type: ErrorBody, description: "ADVANCE_ALREADY_DECIDED" })
  @ApiNotFoundResponse({ type: ErrorBody, description: "ADVANCE_NOT_FOUND" })
  @ApiParam({ name: "id", description: "Advance id (UUID)", example: "ee5e4c9f-9f5c-4ebd-8759-9b7ac5ed3696" })
  cancel(@CurrentViewer() viewer: Viewer, @Param("id") id: string): Promise<SalaryAdvance> {
    return this.advances.cancel(viewer, id);
  }
}
