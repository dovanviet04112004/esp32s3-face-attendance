import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Certificate } from "@prisma/client";

import type { Page } from "../../common/dto/pagination.dto.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { CurrentViewer, type Viewer } from "../../common/scope/viewer.js";
import { CertificatesService } from "./certificates.service.js";
import {
  AskCertificateDto,
  DecideCertificateDto,
  ListCertificatesDto,
} from "./dto/certificate.dto.js";

@ApiTags("certificates")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("certificates")
export class CertificatesController {
  constructor(private readonly certificates: CertificatesService) {}

  @Post()
  @ApiOperation({ summary: "Ask for a letter of employment or of income" })
  ask(@Body() body: AskCertificateDto, @CurrentViewer() viewer: Viewer): Promise<Certificate> {
    return this.certificates.ask(viewer, body);
  }

  @Get()
  @ApiOperation({ summary: "Letters asked for, narrowed to what the caller may see" })
  list(
    @Query() query: ListCertificatesDto,
    @CurrentViewer() viewer: Viewer,
  ): Promise<Page<Certificate>> {
    return this.certificates.list(viewer, query);
  }

  @Get(":id/letter")
  @ApiOperation({ summary: "The issued letter itself, ready to print" })
  letter(
    @Param("id") id: string,
    @CurrentViewer() viewer: Viewer,
  ): Promise<{ serial: string; text: string }> {
    return this.certificates.letter(viewer, id);
  }

  @Post(":id/issue")
  @ApiOperation({ summary: "Hand one out; the database mints the serial" })
  issue(@Param("id") id: string, @CurrentViewer() viewer: Viewer): Promise<Certificate> {
    return this.certificates.issue(viewer, id);
  }

  @Post(":id/reject")
  @ApiOperation({ summary: "Turn one down, with a reason the asker can read" })
  reject(
    @Param("id") id: string,
    @Body() body: DecideCertificateDto,
    @CurrentViewer() viewer: Viewer,
  ): Promise<Certificate> {
    return this.certificates.reject(viewer, id, body);
  }
}
