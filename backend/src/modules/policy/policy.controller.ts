import { Body, Controller, Get, HttpStatus, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";

import { ApiErrors } from "../../common/decorators/api-docs.decorator.js";
import { AuditedInService } from "../../common/decorators/audited.decorator.js";
import { Roles } from "../../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { CurrentViewer, type Viewer } from "../../common/scope/viewer.js";
import { CreatePolicyDto, EffectivePolicyQueryDto, PolicyListQueryDto, PolicyView } from "./dto/policy.dto.js";
import { PolicyService, type PolicyWithBrackets } from "./policy.service.js";

@ApiTags("policy")
@ApiBearerAuth()
@ApiErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("payroll-policies")
export class PolicyController {
  constructor(private readonly policy: PolicyService) {}

  @Get()
  @Roles("ADMIN", "HR", "PAYROLL")
  @ApiOperation({ summary: "Every policy, newest effective date first" })
  @ApiOkResponse({ type: [PolicyView] })
  list(@Query() query: PolicyListQueryDto): Promise<PolicyWithBrackets[]> {
    return this.policy.list(query.legalEntityId);
  }

  @Get("effective")
  @Roles("ADMIN", "HR", "PAYROLL")
  @ApiOperation({ summary: "The policy in force on a date; an entity's own row outranks the company-wide one" })
  @ApiOkResponse({ type: PolicyView })
  @ApiErrors(HttpStatus.NOT_FOUND)
  effective(@Query() query: EffectivePolicyQueryDto): Promise<PolicyWithBrackets> {
    return this.policy.effectiveAt(query.on ? new Date(query.on) : new Date(), query.legalEntityId ?? null);
  }

  @Post()
  @AuditedInService()
  @Roles("ADMIN", "PAYROLL")
  @ApiOperation({ summary: "A change of policy is a new row, never an edit" })
  @ApiCreatedResponse({ type: PolicyView })
  @ApiErrors(HttpStatus.CONFLICT)
  create(
    @CurrentViewer() viewer: Viewer,
    @Body() body: CreatePolicyDto,
  ): Promise<PolicyWithBrackets> {
    return this.policy.create(body, viewer.userId);
  }
}
