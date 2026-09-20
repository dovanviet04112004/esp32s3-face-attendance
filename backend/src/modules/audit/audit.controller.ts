import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { AuditLog } from "@prisma/client";

import { Roles } from "../../common/decorators/roles.decorator.js";
import type { Page } from "../../common/dto/pagination.dto.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { AuditService } from "./audit.service.js";
import { AuditQueryDto } from "./dto/audit-query.dto.js";

@ApiTags("audit")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("ADMIN")
@Controller("audit")
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @ApiOperation({ summary: "What people changed, newest first; filter by subject or actor" })
  list(@Query() query: AuditQueryDto): Promise<Page<AuditLog>> {
    return this.audit.list(query);
  }
}
