import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from "@nestjs/swagger";
import type { Request, Response } from "express";

import { API_AUTH, ApiErrors } from "../../common/decorators/api-docs.decorator.js";
import { AuditedInService } from "../../common/decorators/audited.decorator.js";
import { Roles } from "../../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import type { AccessClaims } from "../auth/auth.types.js";
import {
  FleetUpdateView,
  ImageLinkDto,
  OfferAllDto,
  OfferAllView,
  OfferView,
  OfferStatusView,
  PublishedView,
  PublishQueryDto,
  PublishResultView,
  ReleaseViewDto,
} from "./dto/release.dto.js";
import { ModelsService, type FleetUpdate, type OfferStatus, type ReleaseView } from "./models.service.js";
import { PublishGuard } from "./publish.guard.js";

function actorOf(req: Request): string {
  return (req.user as AccessClaims).sub;
}

/** What people do with releases: see them and offer them to kiosks (KEHOACH 7.7). */
@ApiTags("releases")
@ApiBearerAuth()
@ApiErrors(HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND)
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("releases")
export class ModelsController {
  constructor(private readonly models: ModelsService) {}

  @Get()
  @Roles("ADMIN")
  @ApiOperation({ summary: "Every firmware and models release on the register, newest first" })
  @ApiOkResponse({ type: [ReleaseViewDto] })
  list(): Promise<ReleaseView[]> {
    return this.models.list();
  }

  @Get("fleet")
  @Roles("ADMIN")
  @ApiOperation({ summary: "The newest offerable release of each kind and the kiosks running something older" })
  @ApiOkResponse({ type: [FleetUpdateView] })
  fleet(): Promise<FleetUpdate[]> {
    return this.models.fleet();
  }

  @Get("status/:deviceId")
  @Roles("ADMIN")
  @ApiOperation({ summary: "How the newest update offer to one kiosk went; null when it never had one" })
  @ApiOkResponse({ type: OfferStatusView })
  status(@Param("deviceId") deviceId: string): Promise<OfferStatus | null> {
    return this.models.status(deviceId);
  }

  @Post(":releaseId/offer")
  @Roles("ADMIN")
  @ApiOperation({ summary: "Offer a release to every approved, online kiosk running something older and not installing already" })
  @ApiCreatedResponse({ type: OfferAllView })
  @ApiErrors(HttpStatus.CONFLICT, HttpStatus.GONE)
  offerAll(
    @Param("releaseId") releaseId: string,
    @Body() body: OfferAllDto,
    @Req() req: Request,
  ): Promise<{ offered: string[]; failed: string[]; busy: string[]; offline: string[] }> {
    return this.models.offerAll(releaseId, actorOf(req), body.recapture ?? false);
  }

  @Post(":releaseId/offer/:deviceId")
  @AuditedInService()
  @Roles("ADMIN")
  @ApiOperation({ summary: "Offer a release to one kiosk, which checks it again itself" })
  @ApiCreatedResponse({ type: OfferView })
  @ApiErrors(HttpStatus.CONFLICT, HttpStatus.GONE)
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
  @ApiBearerAuth(API_AUTH.publisher)
  @ApiOperation({ summary: "Publish the release in the body, an application/octet-stream" })
  @ApiConsumes("application/octet-stream")
  @ApiBody({ schema: { type: "string", format: "binary" }, description: "The image file itself" })
  @ApiCreatedResponse({ type: PublishResultView })
  @ApiErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  publish(@Query() query: PublishQueryDto, @Req() req: Request): Promise<{ release: ReleaseView; existing: boolean }> {
    return this.models.publish(query, req);
  }

  @Get("published")
  @UseGuards(PublishGuard)
  @ApiBearerAuth(API_AUTH.publisher)
  @ApiOperation({ summary: "Whether a target and version are already published" })
  @ApiOkResponse({ type: PublishedView })
  @ApiErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
  published(@Query() query: PublishQueryDto): Promise<{ published: boolean }> {
    return this.models.published(query.target, query.version);
  }

  @Get(":releaseId/image")
  @ApiOperation({ summary: "The file a signed update link names" })
  @ApiProduces("application/octet-stream")
  @ApiOkResponse({ schema: { type: "string", format: "binary" } })
  @ApiErrors(HttpStatus.FORBIDDEN, HttpStatus.GONE)
  async image(
    @Param("releaseId") releaseId: string,
    @Query() link: ImageLinkDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const { stream, sizeBytes } = await this.models.image(releaseId, link.device, link.exp, link.sig);
    // A file gone from the volume answers with a code, not the default handler's sentence.
    return new StreamableFile(stream, { type: "application/octet-stream", length: sizeBytes }).setErrorHandler(
      (error, out) => {
        if (out.destroyed) {
          return;
        }
        if (out.headersSent) {
          out.end();
          return;
        }
        out.statusCode = HttpStatus.GONE;
        res.setHeader("Content-Type", "application/json");
        res.removeHeader("Content-Length");
        out.send(JSON.stringify({ statusCode: HttpStatus.GONE, message: "RELEASE_GONE" }));
      },
    );
  }
}
