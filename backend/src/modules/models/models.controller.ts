import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Release } from "@prisma/client";

import { Roles } from "../../common/decorators/roles.decorator.js";
import type { OtaManifest } from "../../common/generated/ota_manifest.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { CreateReleaseDto } from "./dto/release.dto.js";
import { ModelsService } from "./models.service.js";

@ApiTags("releases")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("releases")
export class ModelsController {
  constructor(private readonly models: ModelsService) {}

  @Get()
  @Roles("ADMIN")
  list(): Promise<Release[]> {
    return this.models.list();
  }

  @Post()
  @Roles("ADMIN")
  @ApiOperation({ summary: "Register a firmware or models image" })
  create(@Body() body: CreateReleaseDto): Promise<Release> {
    return this.models.create(body);
  }

  @Post(":releaseId/offer/:deviceId")
  @Roles("ADMIN")
  @ApiOperation({ summary: "Offer a release to one kiosk, which checks it again itself" })
  offer(
    @Param("releaseId") releaseId: string,
    @Param("deviceId") deviceId: string,
  ): Promise<OtaManifest> {
    return this.models.offer(releaseId, deviceId);
  }
}
