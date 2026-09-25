import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Header,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from "@nestjs/swagger";
import type { Employee } from "@prisma/client";

import { ApiErrors } from "../../common/decorators/api-docs.decorator.js";
import { AuditedInService } from "../../common/decorators/audited.decorator.js";
import { ErrorBody } from "../../common/dto/error-body.dto.js";
import type { Page } from "../../common/dto/pagination.dto.js";
import { RateBucket } from "../../common/decorators/rate-bucket.decorator.js";
import { Roles } from "../../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { CurrentViewer, type Viewer } from "../../common/scope/viewer.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { LoginOpenedView, LoginStateView } from "../users/dto/user.dto.js";
import { UsersService } from "../users/users.service.js";
import {
  CreateEmployeeDto,
  EmployeeCountsView,
  EmployeeFilterDto,
  EmployeePage,
  EmployeeView,
  ImportCsvDto,
  ImportQueryDto,
  ImportReportView,
  ListEmployeesDto,
  OffboardDto,
  OnboardDto,
  UpdateEmployeeDto,
} from "./dto/employee.dto.js";
import { THROTTLE } from "../auth/auth.types.js";
import { EmployeesService, type Offboarding, type Onboarding } from "./employees.service.js";
import type { ImportReport } from "./import.js";

@ApiTags("employees")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiErrors(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
@Controller("employees")
export class EmployeesController {
  constructor(
    private readonly employees: EmployeesService,
    private readonly users: UsersService,
  ) {}

  @Get()
  @ApiOperation({ summary: "List the employees the caller may see, by code; departmentId takes the whole branch" })
  @ApiOkResponse({ type: EmployeePage })
  @ApiBadRequestResponse({ type: ErrorBody, description: "CURSOR_INVALID" })
  list(@Query() query: ListEmployeesDto, @CurrentViewer() viewer: Viewer): Promise<Page<Employee>> {
    return this.employees.list(query, viewer);
  }

  @Get("counts")
  @ApiOperation({ summary: "Still working and left, under the search and department filters, for the status filter" })
  @ApiOkResponse({ type: EmployeeCountsView })
  counts(@Query() query: EmployeeFilterDto, @CurrentViewer() viewer: Viewer): Promise<EmployeeCountsView> {
    return this.employees.counts(query, viewer);
  }

  @Post("import")
  @RateBucket(THROTTLE.heavy)
  @Roles("ADMIN", "HR")
  @ApiOperation({
    summary: "Dry run by default; apply=true writes when nothing is wrong",
    description:
      "Updates write only the columns the header names. personalEmail and the bank columns land on new people only; " +
      "pay columns seed the first pay record and are kept otherwise (payKept).",
  })
  @ApiCreatedResponse({ type: ImportReportView })
  @ApiConflictResponse({ type: ErrorBody, description: "MANAGER_CYCLE" })
  importCsv(
    @CurrentViewer() viewer: Viewer,
    @Body() body: ImportCsvDto,
    @Query() query: ImportQueryDto,
  ): Promise<ImportReport> {
    return this.employees.importCsv(viewer, body.csv, query.apply === true);
  }

  @Post(":id/onboard")
  @Roles("ADMIN", "HR")
  @AuditedInService()
  @ApiOperation({ summary: "Take somebody on: contract, pay, leave, checklist and login (KEHOACH 9.14)" })
  onboard(
    @Param("id", ParseIntPipe) id: number,
    @Body() body: OnboardDto,
    @CurrentViewer() viewer: Viewer,
  ): Promise<Onboarding> {
    return this.employees.onboard(viewer, id, body);
  }

  @Post(":id/offboard")
  @Roles("ADMIN", "HR")
  @AuditedInService()
  @ApiOperation({ summary: "Close the record and the login, and list what is still out" })
  offboard(
    @CurrentViewer() viewer: Viewer,
    @Param("id", ParseIntPipe) id: number,
    @Body() body: OffboardDto,
  ): Promise<Offboarding> {
    return this.employees.offboard(viewer, id, body);
  }

  @Get("export")
  @RateBucket(THROTTLE.heavy)
  @Roles("ADMIN", "HR", "PAYROLL")
  @Header("Content-Type", "text/csv; charset=utf-8")
  @ApiProduces("text/csv")
  @ApiOperation({ summary: "The people the list filters show, in the import's own columns" })
  @ApiOkResponse({ type: String, description: "CSV with a byte order mark" })
  exportCsv(@CurrentViewer() viewer: Viewer, @Query() query: EmployeeFilterDto): Promise<string> {
    return this.employees.exportCsv(viewer, query);
  }

  @Get("import/template")
  @Roles("ADMIN", "HR")
  @Header("Content-Type", "text/csv; charset=utf-8")
  @ApiProduces("text/csv")
  @ApiOperation({ summary: "The columns this import reads, and one example line built from this company's catalogues" })
  @ApiOkResponse({ type: String, description: "CSV with a byte order mark" })
  template(): Promise<string> {
    return this.employees.template();
  }

  @Get(":id/login")
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Where this person's login stands: none, pending, active or locked" })
  @ApiOkResponse({ type: LoginStateView })
  @ApiNotFoundResponse({ type: ErrorBody, description: "EMPLOYEE_NOT_FOUND" })
  loginOf(@Param("id", ParseIntPipe) id: number): Promise<LoginStateView> {
    return this.users.loginOf(id);
  }

  @Post(":id/login")
  @Roles("ADMIN", "HR")
  @AuditedInService()
  @ApiOperation({ summary: "Open this person's login, or mail the setup link again when it is open" })
  @ApiCreatedResponse({ type: LoginOpenedView })
  @ApiBadRequestResponse({ type: ErrorBody, description: "NO_EMAIL: the record holds no personal email" })
  @ApiNotFoundResponse({ type: ErrorBody, description: "EMPLOYEE_NOT_FOUND" })
  @ApiConflictResponse({
    type: ErrorBody,
    description: "EMAIL_TAKEN, EMPLOYEE_HAS_LEFT, ACCOUNT_LOCKED, EMPLOYEE_HAS_ACCOUNT",
  })
  openLogin(@Param("id", ParseIntPipe) id: number, @CurrentViewer() viewer: Viewer): Promise<LoginOpenedView> {
    return this.users.openOrResend(viewer.userId, id);
  }

  // Declared above :id, which would otherwise take "next-code" for an id.
  @Get("next-code")
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Carry on the numbering the last hire used, or null if none reads as a series" })
  nextCode(): Promise<{ code: string | null }> {
    return this.employees.nextCode();
  }

  @Get(":id")
  @ApiOperation({ summary: "One employee, as far as the caller's scope reaches" })
  get(
    @Param("id", ParseIntPipe) id: number,
    @CurrentViewer() viewer: Viewer,
  ): Promise<Employee> {
    return this.employees.get(id, viewer);
  }

  @Post()
  @Roles("ADMIN", "HR")
  @AuditedInService()
  @ApiOperation({
    summary: "Create an employee; the server owns the id (KEHOACH 7.5)",
    description: "With no legal entity named, the department's entity, or the only active entity, is used.",
  })
  @ApiCreatedResponse({ type: EmployeeView })
  @ApiBadRequestResponse({ type: ErrorBody, description: "DEPARTMENT_OTHER_ENTITY" })
  @ApiNotFoundResponse({
    type: ErrorBody,
    description: "LEGAL_ENTITY_NOT_FOUND, DEPARTMENT_NOT_FOUND, JOB_TITLE_NOT_FOUND, MANAGER_NOT_FOUND",
  })
  @ApiConflictResponse({ type: ErrorBody, description: "EMPLOYEE_CODE_TAKEN, MANAGER_HAS_LEFT" })
  create(@Body() body: CreateEmployeeDto, @CurrentViewer() viewer: Viewer): Promise<Employee> {
    return this.employees.create(viewer, body);
  }

  @Patch(":id")
  @Roles("ADMIN", "HR")
  @AuditedInService()
  @ApiOperation({
    summary: "Correct an employee record; null clears the manager, department or job title",
    description: "Leaving goes through POST /employees/:id/offboard; there is no field for it here.",
  })
  @ApiOkResponse({ type: EmployeeView })
  @ApiBadRequestResponse({ type: ErrorBody, description: "DEPARTMENT_OTHER_ENTITY" })
  @ApiNotFoundResponse({
    type: ErrorBody,
    description: "EMPLOYEE_NOT_FOUND, LEGAL_ENTITY_NOT_FOUND, DEPARTMENT_NOT_FOUND, JOB_TITLE_NOT_FOUND, MANAGER_NOT_FOUND",
  })
  @ApiConflictResponse({ type: ErrorBody, description: "EMPLOYEE_CODE_TAKEN, MANAGER_CYCLE, MANAGER_HAS_LEFT" })
  update(
    @Param("id", ParseIntPipe) id: number,
    @Body() body: UpdateEmployeeDto,
    @CurrentViewer() viewer: Viewer,
  ): Promise<Employee> {
    return this.employees.update(id, body, viewer);
  }
}
