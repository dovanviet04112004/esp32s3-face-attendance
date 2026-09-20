import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { ProfileChange } from "@prisma/client";

import type { Page } from "../../common/dto/pagination.dto.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { CurrentViewer, type Viewer } from "../../common/scope/viewer.js";
import {
  AskProfileChangeDto,
  DecideProfileChangeDto,
  ListProfileChangesDto,
} from "./dto/profile-change.dto.js";
import { ProfileService } from "./profile.service.js";

@ApiTags("profile-changes")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("profile-changes")
export class ProfileController {
  constructor(private readonly profile: ProfileService) {}

  @Post()
  @ApiOperation({ summary: "Ask to change one thing in a record" })
  ask(@Body() body: AskProfileChangeDto, @CurrentViewer() viewer: Viewer): Promise<ProfileChange> {
    return this.profile.ask(viewer, body);
  }

  @Get()
  @ApiOperation({ summary: "Changes asked for, narrowed to what the caller may see" })
  list(
    @Query() query: ListProfileChangesDto,
    @CurrentViewer() viewer: Viewer,
  ): Promise<Page<ProfileChange>> {
    return this.profile.list(viewer, query);
  }

  @Post(":id/approve")
  @ApiOperation({ summary: "Write it into the record; the asker may not be the one who does" })
  approve(@Param("id") id: string, @CurrentViewer() viewer: Viewer): Promise<ProfileChange> {
    return this.profile.approve(viewer, id);
  }

  @Post(":id/reject")
  @ApiOperation({ summary: "Turn one down, with a reason the asker can read" })
  reject(
    @Param("id") id: string,
    @Body() body: DecideProfileChangeDto,
    @CurrentViewer() viewer: Viewer,
  ): Promise<ProfileChange> {
    return this.profile.reject(viewer, id, body);
  }

  @Post(":id/cancel")
  @ApiOperation({ summary: "Take back a change nobody has answered yet" })
  cancel(@Param("id") id: string, @CurrentViewer() viewer: Viewer): Promise<ProfileChange> {
    return this.profile.cancel(viewer, id);
  }
}
