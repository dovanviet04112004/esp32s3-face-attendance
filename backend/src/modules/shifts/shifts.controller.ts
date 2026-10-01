import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";
import type { Shift, ShiftAssignment } from "@prisma/client";

import type { Page } from "../../common/dto/pagination.dto.js";
import { API_AUTH, ApiErrors } from "../../common/decorators/api-docs.decorator.js";
import { AuditedInService } from "../../common/decorators/audited.decorator.js";
import { RateBucket } from "../../common/decorators/rate-bucket.decorator.js";
import { Roles } from "../../common/decorators/roles.decorator.js";
import { ErrorBody } from "../../common/dto/error-body.dto.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import {
  AssignedManyView,
  AssignManyDto,
  AssignShiftDto,
  AssignmentView,
  CreateShiftDto,
  HeldShiftView,
  ListAssignmentsDto,
  PlannedDayView,
  RosterDto,
  RosterPageView,
  ShiftView,
  UpdateShiftDto,
} from "./dto/shift.dto.js";
import { CurrentViewer, type Viewer } from "../../common/scope/viewer.js";
import { THROTTLE } from "../auth/auth.types.js";
import { BulkQueryDto } from "../employees/dto/employee.dto.js";
import { BulkService } from "../employees/bulk.service.js";
import {
  ShiftsService,
  type HeldShift,
  type PlannedDay,
  type RosteredAssignment,
  type ShiftBatch,
} from "./shifts.service.js";

@ApiTags("shifts")
@ApiBearerAuth(API_AUTH.user)
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
@Controller("shifts")
export class ShiftsController {
  constructor(
    private readonly shifts: ShiftsService,
    private readonly bulk: BulkService,
  ) {}

  @Get()
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Every shift, retired ones included" })
  @ApiOkResponse({ type: [ShiftView] })
  list(): Promise<Shift[]> {
    return this.shifts.list();
  }

  @Get("roster")
  @ApiOperation({ summary: "One person's month ahead: shift, holiday, days away" })
  @ApiOkResponse({ type: [PlannedDayView], description: "Every day of the month, in order" })
  roster(@Query() query: RosterDto, @CurrentViewer() viewer: Viewer): Promise<PlannedDay[]> {
    return this.shifts.roster(viewer, query);
  }

  @Get("people/:employeeId")
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Every shift one person has been put on, the latest start first" })
  @ApiOkResponse({ type: [HeldShiftView] })
  @ApiNotFoundResponse({ type: ErrorBody, description: "EMPLOYEE_NOT_FOUND" })
  @ApiParam({ name: "employeeId", description: "Employee id", example: 42 })
  heldBy(@Param("employeeId", ParseIntPipe) employeeId: number): Promise<HeldShift[]> {
    return this.shifts.heldBy(employeeId);
  }

  @Get(":id")
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "One shift and the hours it keeps" })
  @ApiOkResponse({ type: ShiftView })
  @ApiParam({ name: "id", description: "Shift id (UUID)", example: "2dbf73fd-d71d-4d2a-bacd-0362ce6b4cff" })
  get(@Param("id") id: string): Promise<Shift> {
    return this.shifts.get(id);
  }

  @Post()
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Add a shift" })
  @ApiCreatedResponse({ type: ShiftView })
  create(@Body() body: CreateShiftDto): Promise<Shift> {
    return this.shifts.create(body);
  }

  @Patch(":id")
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Change a shift's hours or its grace" })
  @ApiOkResponse({ type: ShiftView })
  @ApiNotFoundResponse({ type: ErrorBody, description: "SHIFT_NOT_FOUND" })
  @ApiConflictResponse({ type: ErrorBody, description: "SHIFT_NAME_TAKEN" })
  @ApiParam({ name: "id", description: "Shift id (UUID)", example: "2dbf73fd-d71d-4d2a-bacd-0362ce6b4cff" })
  update(@Param("id") id: string, @Body() body: UpdateShiftDto): Promise<Shift> {
    return this.shifts.update(id, body);
  }

  @Delete(":id")
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Retire a shift; assignments already made stay readable" })
  @ApiOkResponse({ type: ShiftView, description: "The shift, now inactive" })
  @ApiParam({ name: "id", description: "Shift id (UUID)", example: "2dbf73fd-d71d-4d2a-bacd-0362ce6b4cff" })
  deactivate(@Param("id") id: string): Promise<Shift> {
    return this.shifts.deactivate(id);
  }

  @Get(":id/assignments")
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Who works this shift, and from when, newest first" })
  @ApiOkResponse({ type: RosterPageView })
  @ApiNotFoundResponse({ type: ErrorBody, description: "SHIFT_NOT_FOUND" })
  @ApiParam({ name: "id", description: "Shift id (UUID)", example: "2dbf73fd-d71d-4d2a-bacd-0362ce6b4cff" })
  assignments(
    @Param("id") id: string,
    @Query() query: ListAssignmentsDto,
  ): Promise<Page<RosteredAssignment>> {
    return this.shifts.assignments(id, query);
  }

  @Post(":id/assignments")
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Put somebody on this shift from a date" })
  @ApiCreatedResponse({ type: AssignmentView })
  @ApiNotFoundResponse({ type: ErrorBody, description: "SHIFT_NOT_FOUND | EMPLOYEE_NOT_FOUND" })
  @ApiConflictResponse({ type: ErrorBody, description: "SHIFT_ALREADY_ASSIGNED" })
  @ApiParam({ name: "id", description: "Shift id (UUID)", example: "2dbf73fd-d71d-4d2a-bacd-0362ce6b4cff" })
  assign(@Param("id") id: string, @Body() body: AssignShiftDto): Promise<ShiftAssignment> {
    return this.shifts.assign(id, body);
  }

  @Post(":id/assignments/bulk")
  @RateBucket(THROTTLE.heavy)
  @Roles("ADMIN", "HR")
  @AuditedInService()
  @ApiOperation({
    summary: "Preview putting many people on this shift from one date; apply=true writes (KEHOACH 9.20)",
    description: "Takes employeeIds or the directory's filter. People who left are skipped, as is anyone already on it from that date.",
  })
  @ApiCreatedResponse({ type: AssignedManyView })
  @ApiBadRequestResponse({ type: ErrorBody, description: "SELECTION_INVALID, SELECTION_TOO_LARGE" })
  @ApiNotFoundResponse({ type: ErrorBody, description: "SHIFT_NOT_FOUND" })
  @ApiParam({ name: "id", description: "Shift id (UUID)", example: "2dbf73fd-d71d-4d2a-bacd-0362ce6b4cff" })
  async assignMany(
    @CurrentViewer() viewer: Viewer,
    @Param("id") id: string,
    @Body() body: AssignManyDto,
    @Query() query: BulkQueryDto,
  ): Promise<ShiftBatch> {
    const chosen = await this.bulk.resolve(viewer, body);
    return this.shifts.assignMany(viewer.userId, id, chosen, body, query.apply === true);
  }

  @Delete(":id/assignments/:assignmentId")
  @Roles("ADMIN", "HR")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Take somebody off this shift" })
  @ApiNoContentResponse({ description: "The assignment is gone" })
  @ApiParam({ name: "id", description: "Shift id (UUID)", example: "2dbf73fd-d71d-4d2a-bacd-0362ce6b4cff" })
  @ApiParam({
    name: "assignmentId",
    description: "Assignment id (UUID)",
    example: "cff6a5b9-52f0-4050-92ef-b929a9911dac",
  })
  unassign(
    @Param("id") id: string,
    @Param("assignmentId") assignmentId: string,
  ): Promise<void> {
    return this.shifts.unassign(id, assignmentId);
  }
}
