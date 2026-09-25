import { Body, Controller, Get, HttpStatus, Param, Post, Query, UseGuards } from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import type { Certificate } from "@prisma/client";

import type { Page } from "../../common/dto/pagination.dto.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { CurrentViewer, type Viewer } from "../../common/scope/viewer.js";
import { API_AUTH, ApiErrors } from "../../common/decorators/api-docs.decorator.js";
import { AuditedInService } from "../../common/decorators/audited.decorator.js";
import { ErrorBody } from "../../common/dto/error-body.dto.js";
import { CertificatesService, type CertificateRow } from "./certificates.service.js";
import {
  AskCertificateDto,
  CertificatePageView,
  CertificateView,
  DecideCertificateDto,
  LetterView,
  ListCertificatesDto,
} from "./dto/certificate.dto.js";

@ApiTags("certificates")
@ApiBearerAuth(API_AUTH.user)
@ApiErrors(HttpStatus.UNAUTHORIZED)
@ApiNotFoundResponse({ type: ErrorBody, description: "CERTIFICATE_NOT_FOUND, also outside the viewer's scope" })
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("certificates")
export class CertificatesController {
  constructor(private readonly certificates: CertificatesService) {}

  @Post()
  @AuditedInService()
  @ApiOperation({ summary: "Ask for a letter of employment or of income" })
  @ApiCreatedResponse({ type: CertificateView })
  @ApiForbiddenResponse({ type: ErrorBody, description: "NO_EMPLOYEE_RECORD" })
  ask(@Body() body: AskCertificateDto, @CurrentViewer() viewer: Viewer): Promise<Certificate> {
    return this.certificates.ask(viewer, body);
  }

  @Get()
  @ApiOperation({ summary: "Letters asked for: the desk sees all but its own waiting rows, others their own" })
  @ApiOkResponse({ type: CertificatePageView })
  list(
    @Query() query: ListCertificatesDto,
    @CurrentViewer() viewer: Viewer,
  ): Promise<Page<CertificateRow>> {
    return this.certificates.list(viewer, query);
  }

  @Get(":id/letter")
  @ApiOperation({ summary: "The issued letter itself, ready to print; the desk or its owner only" })
  @ApiOkResponse({ type: LetterView })
  @ApiBadRequestResponse({ type: ErrorBody, description: "CERTIFICATE_NOT_ISSUED" })
  letter(
    @Param("id") id: string,
    @CurrentViewer() viewer: Viewer,
  ): Promise<{ serial: string; text: string }> {
    return this.certificates.letter(viewer, id);
  }

  @Post(":id/issue")
  @AuditedInService()
  @ApiOperation({ summary: "Hand one out; the database mints the serial" })
  @ApiCreatedResponse({ type: CertificateView })
  @ApiForbiddenResponse({ type: ErrorBody, description: "HR_ONLY, SELF_DECISION" })
  @ApiBadRequestResponse({ type: ErrorBody, description: "CERTIFICATE_ALREADY_DECIDED" })
  issue(@Param("id") id: string, @CurrentViewer() viewer: Viewer): Promise<Certificate> {
    return this.certificates.issue(viewer, id);
  }

  @Post(":id/reject")
  @AuditedInService()
  @ApiOperation({ summary: "Turn one down, with a reason the asker can read" })
  @ApiCreatedResponse({ type: CertificateView })
  @ApiForbiddenResponse({ type: ErrorBody, description: "HR_ONLY, SELF_DECISION" })
  @ApiBadRequestResponse({ type: ErrorBody, description: "CERTIFICATE_ALREADY_DECIDED" })
  reject(
    @Param("id") id: string,
    @Body() body: DecideCertificateDto,
    @CurrentViewer() viewer: Viewer,
  ): Promise<Certificate> {
    return this.certificates.reject(viewer, id, body);
  }
}
