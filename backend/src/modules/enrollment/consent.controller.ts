import { Body, Controller, Get, Param, ParseIntPipe, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { BiometricConsent } from "@prisma/client";

import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { CurrentViewer, type Viewer } from "../../common/scope/viewer.js";
import { ConsentService } from "./consent.service.js";
import { GrantConsentDto } from "./dto/consent.dto.js";
import { EnrollmentService } from "./enrollment.service.js";

@ApiTags("biometric-consent")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("biometric-consents")
export class ConsentController {
  constructor(
    private readonly consent: ConsentService,
    private readonly enrollment: EnrollmentService,
  ) {}

  @Get(":employeeId")
  @ApiOperation({ summary: "Every agreement and withdrawal for one person" })
  history(
    @CurrentViewer() viewer: Viewer,
    @Param("employeeId", ParseIntPipe) employeeId: number,
  ): Promise<BiometricConsent[]> {
    return this.consent.history(viewer, employeeId);
  }

  @Post()
  @ApiOperation({ summary: "Agree to face data, apart from the contract (KEHOACH 9.19)" })
  grant(@CurrentViewer() viewer: Viewer, @Body() body: GrantConsentDto): Promise<BiometricConsent> {
    return this.consent.grant(viewer, body);
  }

  @Post(":employeeId/withdraw")
  @ApiOperation({ summary: "Withdraw, which erases the face on every kiosk at once" })
  async withdraw(
    @CurrentViewer() viewer: Viewer,
    @Param("employeeId", ParseIntPipe) employeeId: number,
  ): Promise<{ consent: BiometricConsent; devices: number }> {
    const consent = await this.consent.withdraw(viewer, employeeId);
    const erased = await this.enrollment.erase(employeeId, viewer.userId, "consent withdrawn");
    return { consent, devices: erased.devices };
  }
}
