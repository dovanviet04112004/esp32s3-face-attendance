import {
  Body,
  Controller,
  Get,
  Header,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
} from "@nestjs/swagger";
import type { Asset, AssetTransfer } from "@prisma/client";

import type { Page } from "../../common/dto/pagination.dto.js";

import { RateBucket } from "../../common/decorators/rate-bucket.decorator.js";
import { AuditedInService } from "../../common/decorators/audited.decorator.js";
import { API_AUTH, ApiErrors } from "../../common/decorators/api-docs.decorator.js";
import { Roles } from "../../common/decorators/roles.decorator.js";
import { ErrorBody } from "../../common/dto/error-body.dto.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { CurrentViewer, type Viewer } from "../../common/scope/viewer.js";
import { THROTTLE } from "../auth/auth.types.js";
import { AssetsService, type AssetCounts, type AssetRow, type AssetWithHolder } from "./assets.service.js";
import {
  AssetCountsView,
  AssetFilterDto,
  AssetPageView,
  AssetView,
  CreateAssetDto,
  HandOverDto,
  ListAssetsDto,
  UpdateAssetDto,
} from "./dto/asset.dto.js";

@ApiTags("assets")
@ApiBearerAuth(API_AUTH.user)
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
@Controller()
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  @Get("assets")
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "The asset register, narrowed by state, kind, holder or a search" })
  @ApiOkResponse({ type: AssetPageView })
  list(@Query() query: ListAssetsDto): Promise<Page<AssetRow>> {
    return this.assets.list(query);
  }

  @Get("assets/counts")
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "How many assets stand in each state under the other filters, and the kinds" })
  @ApiOkResponse({ type: AssetCountsView })
  counts(@Query() query: AssetFilterDto): Promise<AssetCounts> {
    return this.assets.counts(query);
  }

  @Get("assets/export")
  @RateBucket(THROTTLE.heavy)
  @Roles("ADMIN", "HR")
  @Header("Content-Type", "text/csv; charset=utf-8")
  @ApiProduces("text/csv")
  @ApiOperation({ summary: "The register under the list's filters, as a file Excel opens" })
  @ApiOkResponse({ description: "CSV with a byte order mark", schema: { type: "string" } })
  exportCsv(@Query() query: AssetFilterDto): Promise<string> {
    return this.assets.exportCsv(query);
  }

  @Post("assets")
  @AuditedInService()
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Put an asset on the register" })
  @ApiCreatedResponse({ type: AssetView })
  @ApiConflictResponse({ type: ErrorBody, description: "ASSET_CODE_TAKEN" })
  create(@CurrentViewer() viewer: Viewer, @Body() body: CreateAssetDto): Promise<Asset> {
    return this.assets.create(viewer, body);
  }

  @Patch("assets/:id")
  @AuditedInService()
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Correct an asset's name, kind, serial number or note" })
  @ApiOkResponse({ type: AssetView })
  @ApiNotFoundResponse({ type: ErrorBody, description: "ASSET_NOT_FOUND" })
  update(@CurrentViewer() viewer: Viewer, @Param("id") id: string, @Body() body: UpdateAssetDto): Promise<Asset> {
    return this.assets.update(viewer, id, body);
  }

  @Get("assets/:id/history")
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Who this asset has been through, newest first" })
  history(@Param("id") id: string): Promise<AssetTransfer[]> {
    return this.assets.history(id);
  }

  @Post("assets/:id/hand-over")
  @AuditedInService()
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Give it out or take it back; either way a row is written" })
  @ApiCreatedResponse({ type: AssetView })
  @ApiNotFoundResponse({ type: ErrorBody, description: "ASSET_NOT_FOUND | EMPLOYEE_NOT_FOUND" })
  @ApiConflictResponse({
    type: ErrorBody,
    description: "ASSET_ALREADY_ISSUED | ASSET_NOT_ISSUED | ASSET_HELD_BY_SOMEBODY_ELSE",
  })
  handOver(
    @CurrentViewer() viewer: Viewer,
    @Param("id") id: string,
    @Body() body: HandOverDto,
  ): Promise<AssetWithHolder> {
    return this.assets.handOver(viewer, id, body);
  }

  @Get("employees/:id/assets")
  @ApiOperation({ summary: "What this person is still holding" })
  heldBy(
    @CurrentViewer() viewer: Viewer,
    @Param("id", ParseIntPipe) id: number,
  ): Promise<AssetWithHolder[]> {
    return this.assets.heldBy(viewer, id);
  }
}
