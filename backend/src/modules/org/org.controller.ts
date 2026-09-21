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
import type {
  Department,
  EmploymentContract,
  Holiday,
  JobTitle,
  LegalEntity,
} from "@prisma/client";

import { Roles } from "../../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { CurrentViewer, type Viewer } from "../../common/scope/viewer.js";
import {
  CreateContractDto,
  CreateDepartmentDto,
  CreateHolidayDto,
  DecideContractDto,
  ReorgDto,
  UpdateDepartmentDto,
} from "./dto/org.dto.js";
import { OrgService, type DepartmentNode, type ReorgPlan } from "./org.service.js";

@ApiTags("org")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller()
export class OrgController {
  constructor(private readonly org: OrgService) {}

  @Get("holidays")
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Public holidays in a year; the day build reads these" })
  holidays(@Query("year") year?: string): Promise<Holiday[]> {
    return this.org.holidays(year ? Number(year) : undefined);
  }

  @Post("holidays")
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Without one, a public holiday is docked as absent" })
  addHoliday(@CurrentViewer() viewer: Viewer, @Body() body: CreateHolidayDto): Promise<Holiday> {
    return this.org.addHoliday(body, viewer.userId);
  }

  @Delete("holidays/:id")
  @Roles("ADMIN", "HR")
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
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Re-signing is a new contract, never an edit" })
  addContract(
    @CurrentViewer() viewer: Viewer,
    @Body() body: CreateContractDto,
  ): Promise<EmploymentContract> {
    return this.org.addContract(body, viewer.userId);
  }

  @Patch("contracts/:id")
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
  entities(): Promise<LegalEntity[]> {
    return this.org.entities();
  }

  @Get("job-titles")
  @Roles("ADMIN", "HR")
  jobTitles(): Promise<JobTitle[]> {
    return this.org.jobTitles();
  }

  @Post("org/reorg")
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Preview a move by default; apply=true carries it out" })
  reorg(
    @CurrentViewer() viewer: Viewer,
    @Body() body: ReorgDto,
    @Query("apply") apply?: string,
  ): Promise<ReorgPlan> {
    return this.org.reorg(viewer, body, apply === "true");
  }

  @Get("departments")
  @Roles("ADMIN", "HR", "PAYROLL", "MANAGER")
  @ApiOperation({ summary: "The tree flat, with parentId, so a caller shapes it once" })
  departments(@Query("legalEntityId") legalEntityId?: string): Promise<DepartmentNode[]> {
    return this.org.departments(legalEntityId);
  }

  @Post("departments")
  @Roles("ADMIN", "HR")
  create(@Body() body: CreateDepartmentDto): Promise<Department> {
    return this.org.createDepartment(body);
  }

  @Patch("departments/:id")
  @Roles("ADMIN", "HR")
  update(@Param("id") id: string, @Body() body: UpdateDepartmentDto): Promise<Department> {
    return this.org.updateDepartment(id, body);
  }
}
