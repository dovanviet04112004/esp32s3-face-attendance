import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
  Header,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Employee } from "@prisma/client";

import type { Page } from "../../common/dto/pagination.dto.js";
import { Roles } from "../../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { CurrentViewer, type Viewer } from "../../common/scope/viewer.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import {
  CreateEmployeeDto,
  ImportCsvDto,
  ListEmployeesDto,
  OffboardDto,
  UpdateEmployeeDto,
} from "./dto/employee.dto.js";
import { EmployeesService, type Offboarding } from "./employees.service.js";
import { IMPORT_COLUMNS, type ImportReport } from "./import.js";

@ApiTags("employees")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("employees")
export class EmployeesController {
  constructor(private readonly employees: EmployeesService) {}

  @Get()
  @ApiOperation({ summary: "List employees, newest code first" })
  list(@Query() query: ListEmployeesDto, @CurrentViewer() viewer: Viewer): Promise<Page<Employee>> {
    return this.employees.list(query, viewer);
  }

  @Post("import")
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Dry run by default; apply=true writes when nothing is wrong" })
  importCsv(
    @CurrentViewer() viewer: Viewer,
    @Body() body: ImportCsvDto,
    @Query("apply") apply?: string,
  ): Promise<ImportReport> {
    return this.employees.importCsv(viewer, body.csv, apply === "true");
  }

  @Post(":id/offboard")
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Close the record and the login, and list what is still out" })
  offboard(
    @CurrentViewer() viewer: Viewer,
    @Param("id", ParseIntPipe) id: number,
    @Body() body: OffboardDto,
  ): Promise<Offboarding> {
    return this.employees.offboard(viewer, id, body);
  }

  @Get("export")
  @Roles("ADMIN", "HR")
  @Header("Content-Type", "text/csv; charset=utf-8")
  @ApiOperation({ summary: "Every person this viewer may read, in the import's own columns" })
  exportCsv(@CurrentViewer() viewer: Viewer): Promise<string> {
    return this.employees.exportCsv(viewer);
  }

  @Get("import/template")
  @Roles("ADMIN", "HR")
  @Header("Content-Type", "text/csv; charset=utf-8")
  @ApiOperation({ summary: "An empty file with the columns this import reads" })
  template(): string {
    return `\ufeff${IMPORT_COLUMNS.join(",")}\r\n`;
  }

  @Get(":id")
  get(
    @Param("id", ParseIntPipe) id: number,
    @CurrentViewer() viewer: Viewer,
  ): Promise<Employee> {
    return this.employees.get(id, viewer);
  }

  @Post()
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Create an employee; the server owns the id (KEHOACH 7.5)" })
  create(@Body() body: CreateEmployeeDto): Promise<Employee> {
    return this.employees.create(body);
  }

  @Patch(":id")
  @Roles("ADMIN", "HR")
  update(
    @Param("id", ParseIntPipe) id: number,
    @Body() body: UpdateEmployeeDto,
    @CurrentViewer() viewer: Viewer,
  ): Promise<Employee> {
    return this.employees.update(id, body, viewer);
  }

  @Delete(":id")
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Retire an employee; the row and its history stay" })
  deactivate(
    @Param("id", ParseIntPipe) id: number,
    @CurrentViewer() viewer: Viewer,
  ): Promise<Employee> {
    return this.employees.deactivate(id, viewer);
  }
}
