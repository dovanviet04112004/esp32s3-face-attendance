import { Body, Controller, Get, HttpStatus, Param, ParseIntPipe, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { BiometricConsent } from "@prisma/client";

import { ApiErrors } from "../../common/decorators/api-docs.decorator.js";
import { AuditedInService } from "../../common/decorators/audited.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { CurrentViewer, type Viewer } from "../../common/scope/viewer.js";
import { ConsentService } from "./consent.service.js";
import { ConsentView, GrantConsentDto, WithdrawnView } from "./dto/consent.dto.js";
import { EnrollmentService } from "./enrollment.service.js";

@ApiTags("biometric-consent")
@ApiBearerAuth()
@ApiErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND)
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("biometric-consents")
export class ConsentController {
  constructor(
    private readonly consent: ConsentService,
    private readonly enrollment: EnrollmentService,
  ) {}

  @Get(":employeeId")
  @ApiOperation({ summary: "Every agreement and withdrawal for one person" })
  @ApiOkResponse({ type: [ConsentView] })
  history(
    @CurrentViewer() viewer: Viewer,
    @Param("employeeId", ParseIntPipe) employeeId: number,
  ): Promise<BiometricConsent[]> {
    return this.consent.history(viewer, employeeId);
  }

  @Post()
  @AuditedInService()
  @ApiOperation({ summary: "Agree to face data, apart from the contract; the server stamps the notice version" })
  @ApiCreatedResponse({ type: ConsentView })
  grant(@CurrentViewer() viewer: Viewer, @Body() body: GrantConsentDto): Promise<BiometricConsent> {
    return this.consent.grant(viewer, body);
  }

  @Post(":employeeId/withdraw")
  @AuditedInService()
  @ApiOperation({ summary: "Withdraw and erase the face everywhere in one step; asking again erases again" })
  @ApiCreatedResponse({ type: WithdrawnView })
  withdraw(
    @CurrentViewer() viewer: Viewer,
    @Param("employeeId", ParseIntPipe) employeeId: number,
  ): Promise<{ consent: BiometricConsent; devices: number }> {
    return this.enrollment.withdrawConsent(viewer, employeeId);
  }
}
