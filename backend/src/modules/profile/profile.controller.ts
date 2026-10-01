import { Body, Controller, Get, HttpStatus, Param, Post, Query, UseGuards } from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";
import type { ProfileChange } from "@prisma/client";

import type { Page } from "../../common/dto/pagination.dto.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { CurrentViewer, type Viewer } from "../../common/scope/viewer.js";
import { API_AUTH, ApiErrors } from "../../common/decorators/api-docs.decorator.js";
import { AuditedInService } from "../../common/decorators/audited.decorator.js";
import { ErrorBody } from "../../common/dto/error-body.dto.js";
import {
  AskProfileChangeDto,
  DecideProfileChangeDto,
  ListProfileChangesDto,
  ProfileChangeDetailView,
  ProfileChangePageView,
  ProfileChangeView,
} from "./dto/profile-change.dto.js";
import { ProfileService, type ProfileChangeDetail, type ProfileChangeRow } from "./profile.service.js";

const CHANGE_ID = { name: "id", description: "Change request id", example: "0f1a2b3c-4d5e-4f6a-9b7c-8d9e0f1a2b3c" };

@ApiTags("profile-changes")
@ApiBearerAuth(API_AUTH.user)
@ApiErrors(HttpStatus.UNAUTHORIZED)
@ApiNotFoundResponse({ type: ErrorBody, description: "PROFILE_CHANGE_NOT_FOUND, EMPLOYEE_NOT_FOUND" })
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("profile-changes")
export class ProfileController {
  constructor(private readonly profile: ProfileService) {}

  @Post()
  @AuditedInService()
  @ApiOperation({ summary: "Ask to change one thing in a record" })
  @ApiCreatedResponse({ type: ProfileChangeView })
  @ApiBadRequestResponse({ type: ErrorBody, description: "PROFILE_FIELD_EMPTY, PROFILE_NO_CHANGE" })
  @ApiConflictResponse({ type: ErrorBody, description: "PROFILE_CHANGE_PENDING" })
  @ApiForbiddenResponse({ type: ErrorBody, description: "NO_EMPLOYEE_RECORD, HR_ONLY" })
  ask(@Body() body: AskProfileChangeDto, @CurrentViewer() viewer: Viewer): Promise<ProfileChange> {
    return this.profile.ask(viewer, body);
  }

  @Get()
  @ApiOperation({ summary: "Changes asked for: the desk sees all but its own waiting rows, others their own" })
  @ApiOkResponse({ type: ProfileChangePageView })
  list(
    @Query() query: ListProfileChangesDto,
    @CurrentViewer() viewer: Viewer,
  ): Promise<Page<ProfileChangeRow>> {
    return this.profile.list(viewer, query);
  }

  @Get(":id")
  @ApiOperation({ summary: "One change request, in the same scope as the list, with who answered it" })
  @ApiParam(CHANGE_ID)
  @ApiOkResponse({ type: ProfileChangeDetailView })
  @ApiNotFoundResponse({ type: ErrorBody, description: "PROFILE_CHANGE_NOT_FOUND, also outside the viewer's scope" })
  one(@Param("id") id: string, @CurrentViewer() viewer: Viewer): Promise<ProfileChangeDetail> {
    return this.profile.one(viewer, id);
  }

  @Post(":id/approve")
  @AuditedInService()
  @ApiOperation({ summary: "Write it into the record; neither its owner nor its asker may be the one who does" })
  @ApiParam(CHANGE_ID)
  @ApiCreatedResponse({ type: ProfileChangeView })
  @ApiForbiddenResponse({ type: ErrorBody, description: "HR_ONLY, SELF_DECISION, DESK_NEEDS_EMPLOYEE" })
  @ApiConflictResponse({ type: ErrorBody, description: "PROFILE_CHANGE_DECIDED" })
  approve(@Param("id") id: string, @CurrentViewer() viewer: Viewer): Promise<ProfileChange> {
    return this.profile.approve(viewer, id);
  }

  @Post(":id/reject")
  @AuditedInService()
  @ApiOperation({ summary: "Turn one down, with a reason the asker can read" })
  @ApiParam(CHANGE_ID)
  @ApiCreatedResponse({ type: ProfileChangeView })
  @ApiForbiddenResponse({ type: ErrorBody, description: "HR_ONLY, SELF_DECISION, DESK_NEEDS_EMPLOYEE" })
  @ApiConflictResponse({ type: ErrorBody, description: "PROFILE_CHANGE_DECIDED" })
  reject(
    @Param("id") id: string,
    @Body() body: DecideProfileChangeDto,
    @CurrentViewer() viewer: Viewer,
  ): Promise<ProfileChange> {
    return this.profile.reject(viewer, id, body);
  }

  @Post(":id/cancel")
  @AuditedInService()
  @ApiOperation({ summary: "Take back a change nobody has answered yet" })
  @ApiParam(CHANGE_ID)
  @ApiCreatedResponse({ type: ProfileChangeView })
  @ApiForbiddenResponse({ type: ErrorBody, description: "PROFILE_NOT_YOURS" })
  @ApiConflictResponse({ type: ErrorBody, description: "PROFILE_CHANGE_DECIDED" })
  cancel(@Param("id") id: string, @CurrentViewer() viewer: Viewer): Promise<ProfileChange> {
    return this.profile.cancel(viewer, id);
  }
}
