import {
  Body,
  Controller,
  Get,
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
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import type { AllowanceType, Dependent } from "@prisma/client";

import type { Page } from "../../common/dto/pagination.dto.js";
import { AuditedInService, NotAudited } from "../../common/decorators/audited.decorator.js";
import { API_AUTH, ApiErrors } from "../../common/decorators/api-docs.decorator.js";
import { Roles } from "../../common/decorators/roles.decorator.js";
import { ErrorBody } from "../../common/dto/error-body.dto.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { CurrentViewer, type Viewer } from "../../common/scope/viewer.js";
import {
  CompensationService,
  type PayRecord,
  type QueuedDependent,
  type RaisePreview,
} from "./compensation.service.js";
import {
  AllowanceTypeView,
  BulkRaiseDto,
  CreateAllowanceTypeDto,
  CreateCompensationDto,
  CreateDependentDto,
  DecideDependentDto,
  DependentPageView,
  DependentView,
  ListAllowanceTypesDto,
  ListDependentsDto,
  PayRecordView,
  RaisePreviewView,
  UpdateAllowanceTypeDto,
} from "./dto/compensation.dto.js";

@ApiTags("compensation")
@ApiBearerAuth(API_AUTH.user)
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
@Controller()
export class CompensationController {
  constructor(private readonly pay: CompensationService) {}

  @Get("allowance-types")
  @Roles("ADMIN", "HR", "PAYROLL")
  @ApiOperation({ summary: "The allowance catalogue a pay record picks from" })
  @ApiOkResponse({ type: [AllowanceTypeView] })
  allowanceTypes(@Query() query: ListAllowanceTypesDto): Promise<AllowanceType[]> {
    return this.pay.allowanceTypes(query.all);
  }

  @Post("allowance-types")
  @AuditedInService()
  @Roles("ADMIN", "PAYROLL")
  @ApiOperation({ summary: "Add an allowance type and the rules the law gives it" })
  @ApiCreatedResponse({ type: AllowanceTypeView })
  @ApiConflictResponse({ type: ErrorBody, description: "ALLOWANCE_CODE_TAKEN" })
  createAllowanceType(
    @CurrentViewer() viewer: Viewer,
    @Body() body: CreateAllowanceTypeDto,
  ): Promise<AllowanceType> {
    return this.pay.createAllowanceType(viewer, body);
  }

  @Patch("allowance-types/:id")
  @AuditedInService()
  @Roles("ADMIN", "PAYROLL")
  @ApiOperation({ summary: "Edit, retire or restore an allowance type; past pay records keep their copy" })
  @ApiOkResponse({ type: AllowanceTypeView })
  @ApiNotFoundResponse({ type: ErrorBody, description: "ALLOWANCE_TYPE_NOT_FOUND" })
  @ApiConflictResponse({ type: ErrorBody, description: "ALLOWANCE_CODE_TAKEN" })
  updateAllowanceType(
    @CurrentViewer() viewer: Viewer,
    @Param("id") id: string,
    @Body() body: UpdateAllowanceTypeDto,
  ): Promise<AllowanceType> {
    return this.pay.updateAllowanceType(viewer, id, body);
  }

  @Get("employees/:id/compensation")
  @ApiOperation({ summary: "Every pay record for one person, newest first" })
  @ApiOkResponse({ type: [PayRecordView] })
  @ApiNotFoundResponse({ type: ErrorBody, description: "EMPLOYEE_NOT_FOUND" })
  history(
    @CurrentViewer() viewer: Viewer,
    @Param("id", ParseIntPipe) id: number,
  ): Promise<PayRecord[]> {
    return this.pay.history(viewer, id);
  }

  @Post("compensation")
  @AuditedInService()
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "A raise appends a record; nothing is overwritten" })
  @ApiCreatedResponse({ type: PayRecordView })
  @ApiBadRequestResponse({ type: ErrorBody, description: "ALLOWANCE_TYPE_REPEATED" })
  @ApiForbiddenResponse({ type: ErrorBody, description: "PAY_WRITE_DENIED | SELF_DECISION" })
  @ApiNotFoundResponse({ type: ErrorBody, description: "EMPLOYEE_NOT_FOUND | ALLOWANCE_TYPE_NOT_FOUND" })
  @ApiConflictResponse({ type: ErrorBody, description: "PAY_DATE_TAKEN" })
  create(@CurrentViewer() viewer: Viewer, @Body() body: CreateCompensationDto): Promise<PayRecord> {
    return this.pay.create(viewer, body);
  }

  @Post("compensation/bulk/preview")
  @NotAudited()
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "What a bulk raise would write; the writer's own record is left out" })
  @ApiCreatedResponse({ type: [RaisePreviewView] })
  preview(@CurrentViewer() viewer: Viewer, @Body() body: BulkRaiseDto): Promise<RaisePreview[]> {
    return this.pay.previewRaise(viewer, body);
  }

  @Post("compensation/bulk")
  @AuditedInService()
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Write the raise the preview showed; allowances carry forward" })
  @ApiCreatedResponse({ schema: { properties: { written: { type: "number" } } } })
  bulk(@CurrentViewer() viewer: Viewer, @Body() body: BulkRaiseDto): Promise<{ written: number }> {
    return this.pay.applyRaise(viewer, body);
  }

  @Get("employees/:id/dependents")
  @ApiOperation({ summary: "Dependants registered against one person" })
  @ApiOkResponse({ type: [DependentView] })
  dependents(
    @CurrentViewer() viewer: Viewer,
    @Param("id", ParseIntPipe) id: number,
  ): Promise<Dependent[]> {
    return this.pay.dependents(viewer, id);
  }

  @Get("dependents")
  @Roles("ADMIN", "HR", "PAYROLL")
  @ApiOperation({ summary: "Registrations in a state, in this viewer's scope; the desk's own waiting ones left out" })
  @ApiOkResponse({ type: DependentPageView })
  queue(
    @CurrentViewer() viewer: Viewer,
    @Query() query: ListDependentsDto,
  ): Promise<Page<QueuedDependent>> {
    return this.pay.dependentQueue(viewer, query);
  }

  @Post("dependents")
  @ApiOperation({ summary: "Register a dependant; the pay desk decides on it" })
  @ApiCreatedResponse({ type: DependentView })
  @ApiNotFoundResponse({ type: ErrorBody, description: "EMPLOYEE_NOT_FOUND" })
  add(@CurrentViewer() viewer: Viewer, @Body() body: CreateDependentDto): Promise<Dependent> {
    return this.pay.addDependent(viewer, body);
  }

  @Post("dependents/:id/decide")
  @AuditedInService()
  @Roles("ADMIN", "PAYROLL")
  @ApiOperation({ summary: "Accept or turn down a registration still waiting" })
  @ApiCreatedResponse({ type: DependentView })
  @ApiForbiddenResponse({ type: ErrorBody, description: "SELF_DECISION" })
  @ApiNotFoundResponse({ type: ErrorBody, description: "DEPENDENT_NOT_FOUND" })
  @ApiConflictResponse({ type: ErrorBody, description: "REQUEST_ALREADY_DECIDED" })
  decide(
    @CurrentViewer() viewer: Viewer,
    @Param("id") id: string,
    @Body() body: DecideDependentDto,
  ): Promise<Dependent> {
    return this.pay.decideDependent(viewer, id, body);
  }
}
