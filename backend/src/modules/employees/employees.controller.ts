import {
  BadRequestException,
  Body,
  Controller,
  createParamDecorator,
  Delete,
  Get,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Header,
  Post,
  Query,
  StreamableFile,
  UseGuards,
  type ExecutionContext,
} from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiProduces,
  ApiTags,
} from "@nestjs/swagger";
import type { Employee } from "@prisma/client";
import type { Request } from "express";

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
  BulkEnrollDto,
  BulkPlacementDto,
  BulkQueryDto,
  BulkSelectionDto,
  CreateEmployeeDto,
  EmployeeCountsView,
  EmployeeFilterDto,
  EmployeePage,
  EmployeeView,
  ExportQueryDto,
  FileFormatDto,
  ImportCsvDto,
  ImportQueryDto,
  ImportReportView,
  EnrollPlanView,
  ListEmployeesDto,
  LoginPlanView,
  MoveLeavingDto,
  OffboardDto,
  OffboardingView,
  OnboardDto,
  PlacementPlanView,
  UpdateEmployeeDto,
} from "./dto/employee.dto.js";
import { THROTTLE } from "../auth/auth.types.js";
import { BulkService, type EnrollPlan, type LoginPlan, type PlacementPlan } from "./bulk.service.js";
import { EmployeesService, type FileOut, type Offboarding, type Onboarding } from "./employees.service.js";
import type { ImportReport, ImportUpload } from "./import.js";
import { XLSX_MIME } from "./workbook.js";

/** The file as it came: xlsx or csv bytes as the raw body, or csv text inside json. */
const Upload = createParamDecorator((_: unknown, context: ExecutionContext): ImportUpload => {
  const req = context.switchToHttp().getRequest<Request>();
  const body: unknown = req.body;
  if (Buffer.isBuffer(body)) {
    return req.is(XLSX_MIME) ? { kind: "xlsx", bytes: body } : { kind: "csv", text: body.toString("utf8") };
  }
  const held = body as { csv?: unknown } | undefined;
  if (typeof held?.csv === "string" && Object.keys(held).length === 1) {
    return { kind: "csv", text: held.csv };
  }
  throw new BadRequestException("IMPORT_FILE_UNREADABLE");
});

function download(file: FileOut): StreamableFile {
  return new StreamableFile(file.body, {
    type: file.type,
    disposition: `attachment; filename="${file.name}"`,
    length: file.body.length,
  });
}

@ApiTags("employees")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiErrors(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
@Controller("employees")
export class EmployeesController {
  constructor(
    private readonly employees: EmployeesService,
    private readonly users: UsersService,
    private readonly bulk: BulkService,
  ) {}

  @Post("bulk/placement")
  @RateBucket(THROTTLE.heavy)
  @Roles("ADMIN", "HR")
  @AuditedInService()
  @ApiOperation({
    summary: "Preview a job title, department, manager or legal entity for many people; apply=true writes (KEHOACH 9.20)",
    description: "Each person goes through the rules of PATCH /employees/:id; whoever fails one is skipped with a reason.",
  })
  @ApiCreatedResponse({ type: PlacementPlanView })
  @ApiBadRequestResponse({
    type: ErrorBody,
    description: "SELECTION_INVALID, SELECTION_TOO_LARGE, BULK_NOTHING_TO_CHANGE, DEPARTMENT_OTHER_ENTITY",
  })
  @ApiNotFoundResponse({
    type: ErrorBody,
    description: "LEGAL_ENTITY_NOT_FOUND, DEPARTMENT_NOT_FOUND, JOB_TITLE_NOT_FOUND, MANAGER_NOT_FOUND",
  })
  @ApiConflictResponse({ type: ErrorBody, description: "MANAGER_HAS_LEFT, MANAGER_CYCLE, SELECTION_CHANGED" })
  placeMany(
    @CurrentViewer() viewer: Viewer,
    @Body() body: BulkPlacementDto,
    @Query() query: BulkQueryDto,
  ): Promise<PlacementPlan> {
    return this.bulk.placement(viewer, body, query.apply === true);
  }

  @Post("bulk/logins")
  @RateBucket(THROTTLE.heavy)
  @Roles("ADMIN", "HR")
  @AuditedInService()
  @ApiOperation({
    summary: "Preview opening logins, or mailing the link again to a login nobody used yet; apply=true does it",
    description: "Letters go on the queue once the accounts are committed (KEHOACH 9.4).",
  })
  @ApiCreatedResponse({ type: LoginPlanView })
  @ApiBadRequestResponse({ type: ErrorBody, description: "SELECTION_INVALID, SELECTION_TOO_LARGE" })
  @ApiConflictResponse({ type: ErrorBody, description: "SELECTION_CHANGED" })
  loginMany(
    @CurrentViewer() viewer: Viewer,
    @Body() body: BulkSelectionDto,
    @Query() query: BulkQueryDto,
  ): Promise<LoginPlan> {
    return this.bulk.logins(viewer, body, query.apply === true);
  }

  @Post("bulk/enrollments")
  @RateBucket(THROTTLE.heavy)
  @Roles("ADMIN", "HR")
  @AuditedInService()
  @ApiOperation({
    summary: "Preview putting many people up for capture on one kiosk; apply=true does it (KEHOACH 7.5)",
    description: "The roster version moves once for the batch; each ASSIGN carries the version applying it reaches.",
  })
  @ApiCreatedResponse({ type: EnrollPlanView })
  @ApiBadRequestResponse({ type: ErrorBody, description: "SELECTION_INVALID, SELECTION_TOO_LARGE" })
  @ApiNotFoundResponse({ type: ErrorBody, description: "DEVICE_NOT_FOUND" })
  enrollMany(
    @CurrentViewer() viewer: Viewer,
    @Body() body: BulkEnrollDto,
    @Query() query: BulkQueryDto,
  ): Promise<EnrollPlan> {
    return this.bulk.enrollments(viewer, body, query.apply === true);
  }

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
  @AuditedInService()
  @ApiOperation({
    summary: "Dry run by default; apply=true writes when no fault is left, warnings or not (KEHOACH 9.20)",
    description:
      "The body is the xlsx or csv file itself, or {csv} as json. For someone already here an empty cell keeps the " +
      "field and a lone - empties it; only people something changes for are written, one audit line each, and " +
      "`changes` lists the fields of the first 100. personalEmail and the bank columns land on new people only (a " +
      "warning otherwise); pay columns seed the first pay record and are kept otherwise (payKept). consentPaper=YES " +
      "records a PAPER consent in the same transaction, so kioskId on that line assigns in the same run.",
  })
  @ApiConsumes(XLSX_MIME, "text/csv", "application/json")
  @ApiBody({ type: ImportCsvDto })
  @ApiCreatedResponse({ type: ImportReportView })
  @ApiBadRequestResponse({ type: ErrorBody, description: "IMPORT_FILE_UNREADABLE" })
  @ApiConflictResponse({ type: ErrorBody, description: "MANAGER_CYCLE" })
  @ApiPayloadTooLargeResponse({ type: ErrorBody, description: "BODY_TOO_LARGE, IMPORT_FILE_TOO_LARGE, IMPORT_TOO_MANY_ROWS" })
  importFile(
    @CurrentViewer() viewer: Viewer,
    @Upload() upload: ImportUpload,
    @Query() query: ImportQueryDto,
  ): Promise<ImportReport> {
    return this.employees.importFile(viewer, upload, query.apply === true);
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
  @ApiOperation({
    summary: "Record the last day and list what is still out (KEHOACH 9.14)",
    description:
      "A last day of today or earlier in APP_TIMEZONE closes the record and the login now; a later one only schedules it, " +
      "and the record closes the morning after that day.",
  })
  @ApiCreatedResponse({ type: OffboardingView })
  @ApiNotFoundResponse({ type: ErrorBody, description: "EMPLOYEE_NOT_FOUND" })
  @ApiConflictResponse({ type: ErrorBody, description: "EMPLOYEE_HAS_LEFT, LEAVING_SCHEDULED" })
  offboard(
    @CurrentViewer() viewer: Viewer,
    @Param("id", ParseIntPipe) id: number,
    @Body() body: OffboardDto,
  ): Promise<Offboarding> {
    return this.employees.offboard(viewer, id, body);
  }

  @Patch(":id/offboard")
  @Roles("ADMIN", "HR")
  @AuditedInService()
  @ApiOperation({ summary: "Move a scheduled last day; one of today or earlier closes the record now" })
  @ApiOkResponse({ type: OffboardingView })
  @ApiNotFoundResponse({ type: ErrorBody, description: "EMPLOYEE_NOT_FOUND" })
  @ApiConflictResponse({ type: ErrorBody, description: "LEAVING_CLOSED, LEAVING_NOT_SCHEDULED" })
  moveLeaving(
    @CurrentViewer() viewer: Viewer,
    @Param("id", ParseIntPipe) id: number,
    @Body() body: MoveLeavingDto,
  ): Promise<Offboarding> {
    return this.employees.moveLeaving(viewer, id, body);
  }

  @Delete(":id/offboard")
  @Roles("ADMIN", "HR")
  @AuditedInService()
  @ApiOperation({ summary: "Call off a scheduled leaving before the record closes" })
  @ApiOkResponse({ type: EmployeeView })
  @ApiNotFoundResponse({ type: ErrorBody, description: "EMPLOYEE_NOT_FOUND" })
  @ApiConflictResponse({ type: ErrorBody, description: "LEAVING_CLOSED, LEAVING_NOT_SCHEDULED" })
  cancelLeaving(@CurrentViewer() viewer: Viewer, @Param("id", ParseIntPipe) id: number): Promise<Employee> {
    return this.employees.cancelLeaving(viewer, id);
  }

  @Get("export")
  @RateBucket(THROTTLE.heavy)
  @Roles("ADMIN", "HR", "PAYROLL")
  @ApiProduces(XLSX_MIME, "text/csv")
  @ApiOperation({
    summary: "The people the list filters show, in the import's own columns; importing it back changes nothing",
    description: "xlsx by default, every cell a string; format=csv gives a csv with a byte order mark.",
  })
  @ApiOkResponse({ schema: { type: "string", format: "binary" } })
  async exportFile(@CurrentViewer() viewer: Viewer, @Query() query: ExportQueryDto): Promise<StreamableFile> {
    return download(await this.employees.exportFile(viewer, query, query.format ?? "xlsx"));
  }

  @Get("import/template")
  @Roles("ADMIN", "HR")
  @ApiProduces(XLSX_MIME, "text/csv")
  @ApiOperation({
    summary: "The columns this import reads, built from the catalogues in use at the moment of download",
    description:
      "xlsx by default: drop-downs of `code · name` point into a catalogues sheet. format=csv gives the header and one example line.",
  })
  @ApiOkResponse({ schema: { type: "string", format: "binary" } })
  async template(@Query() query: FileFormatDto): Promise<StreamableFile> {
    return download(await this.employees.template(query.format ?? "xlsx"));
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
