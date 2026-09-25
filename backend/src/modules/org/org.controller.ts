import {
  Body,
  Controller,
  Delete,
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
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import type { Department, EmploymentContract, Holiday, JobTitle, LegalEntity } from "@prisma/client";

import { AuditedInService } from "../../common/decorators/audited.decorator.js";
import { API_AUTH, ApiErrors } from "../../common/decorators/api-docs.decorator.js";
import { Roles } from "../../common/decorators/roles.decorator.js";
import { ErrorBody } from "../../common/dto/error-body.dto.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { CurrentViewer, type Viewer } from "../../common/scope/viewer.js";
import {
  CreateContractDto,
  CreateDepartmentDto,
  CreateHolidayDto,
  CreateJobTitleDto,
  CreateLegalEntityDto,
  DecideContractDto,
  DepartmentView,
  HolidayQueryDto,
  HolidayView,
  JobTitleView,
  LegalEntityView,
  ListCatalogueDto,
  ListDepartmentsDto,
  ReorgDto,
  ReorgPlanView,
  ReorgQueryDto,
  UpdateDepartmentDto,
  UpdateHolidayDto,
  UpdateJobTitleDto,
  UpdateLegalEntityDto,
} from "./dto/org.dto.js";
import {
  OrgService,
  type DepartmentNode,
  type JobTitleRow,
  type LegalEntityRow,
  type ReorgPlan,
} from "./org.service.js";

@ApiTags("org")
@ApiBearerAuth(API_AUTH.user)
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
@Controller()
export class OrgController {
  constructor(private readonly org: OrgService) {}

  @Get("holidays")
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Public holidays in a year; the day build reads these" })
  @ApiOkResponse({ type: [HolidayView] })
  holidays(@Query() query: HolidayQueryDto): Promise<Holiday[]> {
    return this.org.holidays(query.year);
  }

  @Post("holidays")
  @AuditedInService()
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Without one, a public holiday is docked as absent" })
  @ApiCreatedResponse({ type: HolidayView })
  @ApiConflictResponse({ type: ErrorBody, description: "HOLIDAY_ALREADY_SET" })
  addHoliday(@CurrentViewer() viewer: Viewer, @Body() body: CreateHolidayDto): Promise<Holiday> {
    return this.org.addHoliday(body, viewer.userId);
  }

  @Patch("holidays/:id")
  @AuditedInService()
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Rename a holiday or change whether it is paid" })
  @ApiOkResponse({ type: HolidayView })
  @ApiNotFoundResponse({ type: ErrorBody, description: "HOLIDAY_NOT_FOUND" })
  updateHoliday(
    @CurrentViewer() viewer: Viewer,
    @Param("id") id: string,
    @Body() body: UpdateHolidayDto,
  ): Promise<Holiday> {
    return this.org.updateHoliday(id, body, viewer.userId);
  }

  @Delete("holidays/:id")
  @AuditedInService()
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Take a day off the calendar, which rebuilds it for everybody" })
  @ApiNotFoundResponse({ type: ErrorBody, description: "HOLIDAY_NOT_FOUND" })
  removeHoliday(
    @CurrentViewer() viewer: Viewer,
    @Param("id") id: string,
  ): Promise<{ done: true }> {
    return this.org.removeHoliday(id, viewer.userId);
  }

  @Get("employees/:id/contracts")
  @Roles("ADMIN", "HR", "PAYROLL")
  @ApiOperation({ summary: "Every contract this person has signed, newest first" })
  contracts(@Param("id", ParseIntPipe) id: number): Promise<EmploymentContract[]> {
    return this.org.contracts(id);
  }

  @Post("contracts")
  @AuditedInService()
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Re-signing is a new contract, never an edit" })
  addContract(
    @CurrentViewer() viewer: Viewer,
    @Body() body: CreateContractDto,
  ): Promise<EmploymentContract> {
    return this.org.addContract(body, viewer.userId);
  }

  @Patch("contracts/:id")
  @AuditedInService()
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Move a contract on; activating one ends the rest" })
  decideContract(
    @CurrentViewer() viewer: Viewer,
    @Param("id") id: string,
    @Body() body: DecideContractDto,
  ): Promise<EmploymentContract> {
    return this.org.decideContract(id, body, viewer.userId);
  }

  @Get("legal-entities")
  @Roles("ADMIN", "HR", "PAYROLL")
  @ApiOperation({ summary: "The entities payroll and insurance report against" })
  @ApiOkResponse({ type: [LegalEntityView] })
  entities(@Query() query: ListCatalogueDto): Promise<LegalEntityRow[]> {
    return this.org.entities(query.all);
  }

  @Post("legal-entities")
  @AuditedInService()
  @Roles("ADMIN")
  @ApiOperation({ summary: "Add an entity that runs its own payroll and insurance filing" })
  @ApiCreatedResponse({ type: LegalEntityView })
  @ApiConflictResponse({ type: ErrorBody, description: "ENTITY_CODE_TAKEN" })
  createEntity(@CurrentViewer() viewer: Viewer, @Body() body: CreateLegalEntityDto): Promise<LegalEntity> {
    return this.org.createEntity(body, viewer.userId);
  }

  @Patch("legal-entities/:id")
  @AuditedInService()
  @Roles("ADMIN")
  @ApiOperation({ summary: "Edit, retire or restore an entity" })
  @ApiOkResponse({ type: LegalEntityView })
  @ApiNotFoundResponse({ type: ErrorBody, description: "LEGAL_ENTITY_NOT_FOUND" })
  @ApiConflictResponse({ type: ErrorBody, description: "ENTITY_CODE_TAKEN | ENTITY_IN_USE" })
  updateEntity(
    @CurrentViewer() viewer: Viewer,
    @Param("id") id: string,
    @Body() body: UpdateLegalEntityDto,
  ): Promise<LegalEntity> {
    return this.org.updateEntity(id, body, viewer.userId);
  }

  @Get("job-titles")
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "The grade ladder a hire is placed on" })
  @ApiOkResponse({ type: [JobTitleView] })
  jobTitles(@Query() query: ListCatalogueDto): Promise<JobTitleRow[]> {
    return this.org.jobTitles(query.all);
  }

  @Post("job-titles")
  @AuditedInService()
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Add a job title" })
  @ApiCreatedResponse({ type: JobTitleView })
  @ApiConflictResponse({ type: ErrorBody, description: "JOB_TITLE_CODE_TAKEN" })
  createJobTitle(@CurrentViewer() viewer: Viewer, @Body() body: CreateJobTitleDto): Promise<JobTitle> {
    return this.org.createJobTitle(body, viewer.userId);
  }

  @Patch("job-titles/:id")
  @AuditedInService()
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Edit, retire or restore a job title; holders keep it" })
  @ApiOkResponse({ type: JobTitleView })
  @ApiNotFoundResponse({ type: ErrorBody, description: "JOB_TITLE_NOT_FOUND" })
  @ApiConflictResponse({ type: ErrorBody, description: "JOB_TITLE_CODE_TAKEN" })
  updateJobTitle(
    @CurrentViewer() viewer: Viewer,
    @Param("id") id: string,
    @Body() body: UpdateJobTitleDto,
  ): Promise<JobTitle> {
    return this.org.updateJobTitle(id, body, viewer.userId);
  }

  @Post("org/reorg")
  @AuditedInService()
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Preview a move by default; apply=true carries it out" })
  @ApiCreatedResponse({ type: ReorgPlanView })
  @ApiNotFoundResponse({ type: ErrorBody, description: "REORG_MOVES_NOBODY | DEPARTMENT_NOT_FOUND | EMPLOYEE_NOT_FOUND" })
  @ApiConflictResponse({ type: ErrorBody, description: "MANAGER_CYCLE" })
  reorg(
    @CurrentViewer() viewer: Viewer,
    @Body() body: ReorgDto,
    @Query() query: ReorgQueryDto,
  ): Promise<ReorgPlan> {
    return this.org.reorg(viewer, body, query.apply === true);
  }

  @Get("departments")
  @Roles("ADMIN", "HR", "PAYROLL", "MANAGER")
  @ApiOperation({ summary: "The tree flat, with parentId, so a caller shapes it once" })
  @ApiOkResponse({ type: [DepartmentView] })
  departments(@Query() query: ListDepartmentsDto): Promise<DepartmentNode[]> {
    return this.org.departments(query);
  }

  @Post("departments")
  @AuditedInService()
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Open a department under a parent, or at the top" })
  @ApiCreatedResponse({ type: DepartmentView })
  @ApiNotFoundResponse({ type: ErrorBody, description: "DEPARTMENT_NOT_FOUND | EMPLOYEE_NOT_FOUND" })
  @ApiConflictResponse({ type: ErrorBody, description: "DEPARTMENT_CODE_TAKEN | DEPARTMENT_ENTITY_MISMATCH" })
  create(@CurrentViewer() viewer: Viewer, @Body() body: CreateDepartmentDto): Promise<Department> {
    return this.org.createDepartment(body, viewer.userId);
  }

  @Patch("departments/:id")
  @AuditedInService()
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Rename, move, set the head or cost centre, retire or restore" })
  @ApiOkResponse({ type: DepartmentView })
  @ApiNotFoundResponse({ type: ErrorBody, description: "DEPARTMENT_NOT_FOUND | EMPLOYEE_NOT_FOUND" })
  @ApiConflictResponse({
    type: ErrorBody,
    description: "DEPARTMENT_CODE_TAKEN | DEPARTMENT_CYCLE | DEPARTMENT_IN_USE | DEPARTMENT_ENTITY_MISMATCH",
  })
  update(
    @CurrentViewer() viewer: Viewer,
    @Param("id") id: string,
    @Body() body: UpdateDepartmentDto,
  ): Promise<Department> {
    return this.org.updateDepartment(id, body, viewer.userId);
  }
}
