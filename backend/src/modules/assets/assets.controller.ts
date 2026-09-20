import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Asset, AssetTransfer } from "@prisma/client";

import { Roles } from "../../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { CurrentViewer, type Viewer } from "../../common/scope/viewer.js";
import { AssetsService, type AssetWithHolder } from "./assets.service.js";
import { CreateAssetDto, HandOverDto, ListAssetsDto } from "./dto/asset.dto.js";

@ApiTags("assets")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller()
export class AssetsController {
  constructor(private readonly assets: AssetsService) {}

  @Get("assets")
  @Roles("ADMIN", "HR")
  list(@Query() query: ListAssetsDto): Promise<AssetWithHolder[]> {
    return this.assets.list(query);
  }

  @Post("assets")
  @Roles("ADMIN", "HR")
  create(@Body() body: CreateAssetDto): Promise<Asset> {
    return this.assets.create(body);
  }

  @Get("assets/:id/history")
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Who this asset has been through, newest first" })
  history(@Param("id") id: string): Promise<AssetTransfer[]> {
    return this.assets.history(id);
  }

  @Post("assets/:id/hand-over")
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Give it out or take it back; either way a row is written" })
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
