import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  Patch,
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
  ListEmployeesDto,
  UpdateEmployeeDto,
} from "./dto/employee.dto.js";
import { EmployeesService } from "./employees.service.js";

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
