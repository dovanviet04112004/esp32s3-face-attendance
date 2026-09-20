import { Body, Controller, Get, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import { Roles } from "../../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { CurrentViewer, type Viewer } from "../../common/scope/viewer.js";
import { CreatePolicyDto } from "./dto/policy.dto.js";
import { PolicyService, type PolicyWithBrackets } from "./policy.service.js";

@ApiTags("policy")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("payroll-policies")
export class PolicyController {
  constructor(private readonly policy: PolicyService) {}

  @Get()
  @Roles("ADMIN", "HR", "PAYROLL")
  @ApiOperation({ summary: "Every policy, newest effective date first" })
  list(@Query("legalEntityId") legalEntityId?: string): Promise<PolicyWithBrackets[]> {
    return this.policy.list(legalEntityId);
  }

  @Get("effective")
  @Roles("ADMIN", "HR", "PAYROLL")
  @ApiOperation({ summary: "The policy in force on a date (KEHOACH 9.7)" })
  effective(
    @Query("on") on?: string,
    @Query("legalEntityId") legalEntityId?: string,
  ): Promise<PolicyWithBrackets> {
    return this.policy.effectiveAt(on ? new Date(on) : new Date(), legalEntityId ?? null);
  }

  @Post()
  @Roles("ADMIN", "PAYROLL")
  @ApiOperation({ summary: "A change of policy is a new row, never an edit" })
  create(
    @CurrentViewer() viewer: Viewer,
    @Body() body: CreatePolicyDto,
  ): Promise<PolicyWithBrackets> {
    return this.policy.create(body, viewer.userId);
  }
}
