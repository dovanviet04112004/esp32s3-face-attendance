import { Body, Controller, Get, Header, HttpStatus, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from "@nestjs/swagger";
import type { LeaveType, Request as LeaveRequest } from "@prisma/client";

import { API_AUTH, ApiErrors } from "../../common/decorators/api-docs.decorator.js";
import { AuditedInService } from "../../common/decorators/audited.decorator.js";
import { RateBucket } from "../../common/decorators/rate-bucket.decorator.js";
import { Roles } from "../../common/decorators/roles.decorator.js";
import { ErrorBody } from "../../common/dto/error-body.dto.js";
import type { Page } from "../../common/dto/pagination.dto.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { CurrentViewer, type Viewer } from "../../common/scope/viewer.js";
import { THROTTLE } from "../auth/auth.types.js";
import { CreateLeaveTypeDto, UpdateLeaveTypeDto } from "./dto/leave-type.dto.js";
import {
  BalanceQueryDto,
  BalanceView,
  DecideManyDto,
  DecideManyView,
  DecideRequestDto,
  InboxCountsView,
  InboxPageView,
  LeaveDaysQueryDto,
  LeaveDaysView,
  ListRequestsDto,
  RequestDetailView,
  RequestPageView,
  RequestView,
  SubmitRequestDto,
} from "./dto/request.dto.js";
import {
  LeaveService,
  type BalanceAsOf,
  type DecideManyResult,
  type InboxCounts,
  type InboxRow,
  type LeaveDays,
  type RequestDetail,
  type RequestRow,
} from "./leave.service.js";

@ApiTags("requests")
@ApiBearerAuth(API_AUTH.user)
@ApiErrors(HttpStatus.UNAUTHORIZED)
@ApiBadRequestResponse({ type: ErrorBody, description: "A field or cursor the server refuses" })
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller()
export class LeaveController {
  constructor(private readonly leave: LeaveService) {}

  @Get("leave-types")
  @ApiOperation({ summary: "The kinds of leave a request can name" })
  types(): Promise<LeaveType[]> {
    return this.leave.types();
  }

  @Get("leave-types/all")
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Every kind including retired ones, for the desk that edits them" })
  allTypes(): Promise<LeaveType[]> {
    return this.leave.allTypes();
  }

  @Post("leave-types")
  @AuditedInService()
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Add a kind of leave and what a full year of it earns" })
  createType(
    @CurrentViewer() viewer: Viewer,
    @Body() body: CreateLeaveTypeDto,
  ): Promise<LeaveType> {
    return this.leave.createType(viewer, body);
  }

  @Patch("leave-types/:id")
  @AuditedInService()
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Change what a kind grants, or retire it from the filing form" })
  updateType(
    @CurrentViewer() viewer: Viewer,
    @Param("id") id: string,
    @Body() body: UpdateLeaveTypeDto,
  ): Promise<LeaveType> {
    return this.leave.updateType(viewer, id, body);
  }

  @Get("leave-balances")
  @ApiOperation({ summary: "What somebody has left on a day of the caller's choosing" })
  @ApiOkResponse({ type: [BalanceView] })
  @ApiNotFoundResponse({ type: ErrorBody, description: "EMPLOYEE_NOT_FOUND: outside the viewer's scope" })
  balances(
    @CurrentViewer() viewer: Viewer,
    @Query() query: BalanceQueryDto,
  ): Promise<BalanceAsOf[]> {
    return this.leave.balancesFor(viewer, query.employeeId, new Date(query.asOf ?? Date.now()));
  }

  @Get("leave-days")
  @ApiOperation({ summary: "The working days a leave range would charge the caller, per calendar year (KEHOACH 9.5)" })
  @ApiOkResponse({ type: LeaveDaysView })
  @ApiBadRequestResponse({
    type: ErrorBody,
    description: "LEAVE_NO_WORKING_DAY, HALF_DAY_NOT_WORKING, LEAVE_SPANS_YEARS, DATE_RANGE_BACKWARDS",
  })
  @ApiForbiddenResponse({ type: ErrorBody, description: "NOT_AN_EMPLOYEE" })
  @ApiNotFoundResponse({ type: ErrorBody, description: "LEAVE_TYPE_NOT_FOUND: unknown or retired" })
  leaveDays(@CurrentViewer() viewer: Viewer, @Query() query: LeaveDaysQueryDto): Promise<LeaveDays> {
    return this.leave.leaveDays(viewer, query);
  }

  @Post("requests")
  @ApiOperation({ summary: "File leave, overtime, a correction or a trip (KEHOACH 9.5)" })
  @ApiCreatedResponse({ type: RequestView, description: "A repeated clientKey answers with the request already filed" })
  @ApiConflictResponse({ type: ErrorBody, description: "LEAVE_BALANCE_SHORT, LEAVE_OVERLAP" })
  @ApiForbiddenResponse({ type: ErrorBody, description: "NOT_AN_EMPLOYEE, CLIENT_KEY_NOT_YOURS" })
  @ApiNotFoundResponse({ type: ErrorBody, description: "LEAVE_TYPE_NOT_FOUND: unknown or retired" })
  submit(@CurrentViewer() viewer: Viewer, @Body() body: SubmitRequestDto): Promise<LeaveRequest> {
    return this.leave.submit(viewer, body);
  }

  @Get("requests")
  @ApiOperation({ summary: "The ledger: every state in the viewer's tree, newest first by default" })
  @ApiOkResponse({ type: RequestPageView })
  list(@CurrentViewer() viewer: Viewer, @Query() query: ListRequestsDto): Promise<Page<RequestRow>> {
    return this.leave.list(viewer, query);
  }

  @Get("requests/export")
  @RateBucket(THROTTLE.heavy)
  @Roles("ADMIN", "HR", "MANAGER")
  @Header("Content-Type", "text/csv; charset=utf-8")
  @ApiProduces("text/csv")
  @ApiOperation({ summary: "The ledger under the same filter, as a file Excel opens" })
  @ApiOkResponse({ description: "CSV with a byte order mark", schema: { type: "string" } })
  exportCsv(@CurrentViewer() viewer: Viewer, @Query() query: ListRequestsDto): Promise<string> {
    return this.leave.exportCsv(viewer, query);
  }

  @Get("requests/inbox")
  @ApiOperation({ summary: "What is waiting on this viewer to answer, oldest first by default" })
  @ApiOkResponse({ type: InboxPageView })
  inbox(@CurrentViewer() viewer: Viewer, @Query() query: ListRequestsDto): Promise<Page<InboxRow>> {
    return this.leave.inbox(viewer, query);
  }

  @Get("requests/inbox/counts")
  @ApiOperation({ summary: "How much waits on this viewer in each queue; the badge sums these" })
  @ApiOkResponse({ type: InboxCountsView })
  counts(@CurrentViewer() viewer: Viewer): Promise<InboxCounts> {
    return this.leave.counts(viewer);
  }

  @Post("requests/decide-many")
  @ApiOperation({ summary: "Decide up to 100 at once; each row goes through the single-decision rules" })
  @ApiCreatedResponse({ type: DecideManyView })
  @ApiBadRequestResponse({ type: ErrorBody, description: "DECISION_NOTE_REQUIRED when turning down" })
  decideMany(@CurrentViewer() viewer: Viewer, @Body() body: DecideManyDto): Promise<DecideManyResult> {
    return this.leave.decideMany(viewer, body);
  }

  @Get("requests/:id")
  @ApiOperation({ summary: "One request with its balance and teammates off; declared after inbox and export" })
  @ApiOkResponse({ type: RequestDetailView })
  @ApiNotFoundResponse({ type: ErrorBody, description: "REQUEST_NOT_FOUND, also outside the viewer's scope" })
  one(@CurrentViewer() viewer: Viewer, @Param("id") id: string): Promise<RequestDetail> {
    return this.leave.one(viewer, id);
  }

  @Post("requests/:id/decide")
  @ApiOperation({ summary: "Approve or turn down; the balance moves here" })
  @ApiCreatedResponse({ type: RequestView })
  @ApiForbiddenResponse({ type: ErrorBody, description: "SELF_DECISION, NOT_YOUR_REQUEST" })
  @ApiConflictResponse({ type: ErrorBody, description: "REQUEST_ALREADY_DECIDED" })
  @ApiNotFoundResponse({ type: ErrorBody, description: "REQUEST_NOT_FOUND" })
  decide(
    @CurrentViewer() viewer: Viewer,
    @Param("id") id: string,
    @Body() body: DecideRequestDto,
  ): Promise<LeaveRequest> {
    return this.leave.decide(viewer, id, body);
  }

  @Post("requests/:id/cancel")
  @ApiOperation({ summary: "Withdraw a request nobody has decided yet" })
  @ApiCreatedResponse({ type: RequestView })
  @ApiConflictResponse({ type: ErrorBody, description: "REQUEST_ALREADY_DECIDED" })
  @ApiNotFoundResponse({ type: ErrorBody, description: "REQUEST_NOT_FOUND" })
  cancel(@CurrentViewer() viewer: Viewer, @Param("id") id: string): Promise<LeaveRequest> {
    return this.leave.cancel(viewer, id);
  }
}
