import { Controller, Get, HttpStatus, Query, UseGuards } from "@nestjs/common";
import { ApiBadRequestResponse, ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";

import { ApiErrors } from "../../common/decorators/api-docs.decorator.js";
import { Roles } from "../../common/decorators/roles.decorator.js";
import { ErrorBody } from "../../common/dto/error-body.dto.js";
import type { Page } from "../../common/dto/pagination.dto.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { AUDIT_ACTIONS, AUDIT_SUBJECTS } from "./audit-actions.js";
import { AuditService, type AuditRow } from "./audit.service.js";
import { AuditPageView, AuditQueryDto, AuditVocabularyView } from "./dto/audit-query.dto.js";

@ApiTags("audit")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("ADMIN")
@ApiErrors(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
@Controller("audit")
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @ApiOperation({ summary: "What people changed, newest first; filter by days, action, subject or actor" })
  @ApiOkResponse({ type: AuditPageView })
  @ApiBadRequestResponse({ type: ErrorBody, description: "CURSOR_INVALID, or a filter outside its format" })
  list(@Query() query: AuditQueryDto): Promise<Page<AuditRow>> {
    return this.audit.list(query);
  }

  @Get("vocabulary")
  @ApiOperation({ summary: "Every action and subject name the trail may carry, for the filters (KEHOACH 9.24 rule 2)" })
  @ApiOkResponse({ type: AuditVocabularyView })
  vocabulary(): AuditVocabularyView {
    return { actions: Object.values(AUDIT_ACTIONS), subjects: Object.values(AUDIT_SUBJECTS) };
  }
}
