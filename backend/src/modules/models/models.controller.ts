import { Controller, Get, Param, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request, Response } from "express";

import { Roles } from "../../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import type { AccessClaims } from "../auth/auth.types.js";
import { ImageLinkDto, PublishQueryDto } from "./dto/release.dto.js";
import { ModelsService, type FleetUpdate, type OfferStatus, type ReleaseView } from "./models.service.js";
import { PublishGuard } from "./publish.guard.js";

function actorOf(req: Request): string {
  return (req.user as AccessClaims).sub;
}

/** What people do with releases: see them and offer them to kiosks (KEHOACH 7.7). */
@ApiTags("releases")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("releases")
export class ModelsController {
  constructor(private readonly models: ModelsService) {}

  @Get()
  @Roles("ADMIN")
  @ApiOperation({ summary: "Every firmware and models release on the register, newest first" })
  list(): Promise<ReleaseView[]> {
    return this.models.list();
  }

  @Get("fleet")
  @Roles("ADMIN")
  @ApiOperation({ summary: "The newest offerable release of each kind and the kiosks running something older" })
  fleet(): Promise<FleetUpdate[]> {
    return this.models.fleet();
  }

  @Get("status/:deviceId")
  @Roles("ADMIN")
  @ApiOperation({ summary: "How the newest update offer to one kiosk went" })
  status(@Param("deviceId") deviceId: string): Promise<OfferStatus | null> {
    return this.models.status(deviceId);
  }

  @Post(":releaseId/offer")
  @Roles("ADMIN")
  @ApiOperation({ summary: "Offer a release to every approved kiosk running something older" })
  offerAll(@Param("releaseId") releaseId: string, @Req() req: Request): Promise<{ offered: string[]; failed: string[] }> {
    return this.models.offerAll(releaseId, actorOf(req));
  }

  @Post(":releaseId/offer/:deviceId")
  @Roles("ADMIN")
  @ApiOperation({ summary: "Offer a release to one kiosk, which checks it again itself" })
  offer(
    @Param("releaseId") releaseId: string,
    @Param("deviceId") deviceId: string,
    @Req() req: Request,
  ): Promise<{ deviceId: string; offeredAt: Date }> {
    return this.models.offer(releaseId, deviceId, actorOf(req));
  }
}

/** What machines do with releases: CI or the training box puts one up, a kiosk takes one down. */
@ApiTags("releases")
@Controller("releases")
export class ReleaseFilesController {
  constructor(private readonly models: ModelsService) {}

  @Post()
  @UseGuards(PublishGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Publish the release in the body, an application/octet-stream" })
  publish(@Query() query: PublishQueryDto, @Req() req: Request) {
    return this.models.publish(query, req);
  }

  @Get("published")
  @UseGuards(PublishGuard)
  @ApiBearerAuth()
  @ApiOperation({ summary: "Whether a target and version are already published" })
  published(@Query() query: PublishQueryDto): Promise<{ published: boolean }> {
    return this.models.published(query.target, query.version);
  }

  @Get(":releaseId/image")
  @ApiOperation({ summary: "The file a signed update link names" })
  async image(
    @Param("releaseId") releaseId: string,
    @Query() link: ImageLinkDto,
    @Res() res: Response,
  ): Promise<void> {
    const { stream, sizeBytes } = await this.models.image(releaseId, link.device, link.exp, link.sig);
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Length", String(sizeBytes));
    stream.pipe(res);
  }
}
