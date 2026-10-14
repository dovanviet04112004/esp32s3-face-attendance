import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  Post,
  Put,
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
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiTags,
} from "@nestjs/swagger";
import type { Request, Response } from "express";

import { API_AUTH, ApiErrors } from "../../common/decorators/api-docs.decorator.js";
import { AuditedInService } from "../../common/decorators/audited.decorator.js";
import { Roles } from "../../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { CurrentViewer, type Viewer } from "../../common/scope/viewer.js";
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
  ReleaseDetailsDto,
  ReleaseViewDto,
  UpdateAllDto,
  UpdateView,
} from "./dto/release.dto.js";
import { ModelsService, type FleetUpdate, type OfferStatus, type ReleaseStep, type ReleaseView } from "./models.service.js";
import { PublishGuard } from "./publish.guard.js";

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
  @ApiOperation({ summary: "How the newest update offer to one kiosk went" })
  @ApiOkResponse({ type: OfferStatusView, description: "The newest offer on record and where it stands" })
  @ApiNoContentResponse({ description: "No offer to the kiosk is on record" })
  @ApiParam({ name: "deviceId", description: "Kiosk id", example: "kiosk-2884859fd3c8" })
  async status(
    @Param("deviceId") deviceId: string,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OfferStatus | null> {
    const found = await this.models.status(deviceId);
    if (found === null) {
      res.status(HttpStatus.NO_CONTENT);
    }
    return found;
  }

  @Post("update")
  @AuditedInService()
  @Roles("ADMIN")
  @ApiOperation({ summary: "Bring every approved, online kiosk to the newest firmware and models, in the order their claims allow" })
  @ApiCreatedResponse({ type: OfferAllView })
  @ApiErrors(HttpStatus.CONFLICT)
  updateAll(
    @Body() body: UpdateAllDto,
    @CurrentViewer() viewer: Viewer,
  ): Promise<{ offered: string[]; failed: string[]; busy: string[]; offline: string[] }> {
    return this.models.updateAll(viewer.userId, body.recapture ?? false);
  }

  @Post("update/:deviceId")
  @AuditedInService()
  @Roles("ADMIN")
  @ApiOperation({ summary: "Bring one kiosk to the newest firmware and models: the first step now, each next one once the one ahead is installed" })
  @ApiCreatedResponse({ type: UpdateView })
  @ApiErrors(HttpStatus.CONFLICT)
  @ApiParam({ name: "deviceId", description: "Kiosk id", example: "kiosk-2884859fd3c8" })
  update(
    @Param("deviceId") deviceId: string,
    @CurrentViewer() viewer: Viewer,
  ): Promise<{ deviceId: string; offered: ReleaseStep; next: ReleaseStep | null }> {
    return this.models.update(deviceId, viewer.userId);
  }

  @Post(":releaseId/offer")
  @Roles("ADMIN")
  @ApiOperation({ summary: "Offer a release to every approved, online kiosk running something older and not installing already" })
  @ApiCreatedResponse({ type: OfferAllView })
  @ApiErrors(HttpStatus.CONFLICT, HttpStatus.GONE)
  @ApiParam({ name: "releaseId", description: "Release id (UUID)", example: "ae489569-fcc0-4393-9669-2d459d7c57bd" })
  offerAll(
    @Param("releaseId") releaseId: string,
    @Body() body: OfferAllDto,
    @CurrentViewer() viewer: Viewer,
  ): Promise<{ offered: string[]; failed: string[]; busy: string[]; offline: string[] }> {
    return this.models.offerAll(releaseId, viewer.userId, body.recapture ?? false);
  }

  @Post(":releaseId/offer/:deviceId")
  @AuditedInService()
  @Roles("ADMIN")
  @ApiOperation({ summary: "Offer a release to one kiosk, which checks it again itself" })
  @ApiCreatedResponse({ type: OfferView })
  @ApiErrors(HttpStatus.CONFLICT, HttpStatus.GONE)
  @ApiParam({ name: "releaseId", description: "Release id (UUID)", example: "ae489569-fcc0-4393-9669-2d459d7c57bd" })
  @ApiParam({ name: "deviceId", description: "Kiosk id", example: "kiosk-2884859fd3c8" })
  offer(
    @Param("releaseId") releaseId: string,
    @Param("deviceId") deviceId: string,
    @CurrentViewer() viewer: Viewer,
  ): Promise<{ deviceId: string; offeredAt: Date }> {
    return this.models.offer(releaseId, deviceId, viewer.userId);
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

  @Put("details")
  @UseGuards(PublishGuard)
  @ApiBearerAuth(API_AUTH.publisher)
  @ApiOperation({ summary: "Write the notes of a release already on the register and, for firmware, the models it needs" })
  @ApiOkResponse({ type: ReleaseViewDto })
  @ApiErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND, HttpStatus.CONFLICT)
  describe(@Body() body: ReleaseDetailsDto): Promise<ReleaseView> {
    return this.models.describe(body);
  }

  @Get(":releaseId/image")
  @ApiOperation({ summary: "The file a signed update link names" })
  @ApiProduces("application/octet-stream")
  @ApiOkResponse({ schema: { type: "string", format: "binary" } })
  @ApiErrors(HttpStatus.FORBIDDEN, HttpStatus.GONE)
  @ApiParam({ name: "releaseId", description: "Release id (UUID)", example: "ae489569-fcc0-4393-9669-2d459d7c57bd" })
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
