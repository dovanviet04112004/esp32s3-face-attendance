import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Department, JobTitle, LegalEntity } from "@prisma/client";

import { Roles } from "../../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { CreateDepartmentDto, UpdateDepartmentDto } from "./dto/org.dto.js";
import { OrgService } from "./org.service.js";

@ApiTags("org")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller()
export class OrgController {
  constructor(private readonly org: OrgService) {}

  @Get("legal-entities")
  entities(): Promise<LegalEntity[]> {
    return this.org.entities();
  }

  @Get("job-titles")
  jobTitles(): Promise<JobTitle[]> {
    return this.org.jobTitles();
  }

  @Get("departments")
  @ApiOperation({ summary: "The tree flat, with parentId, so a caller shapes it once" })
  departments(@Query("legalEntityId") legalEntityId?: string): Promise<Department[]> {
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
