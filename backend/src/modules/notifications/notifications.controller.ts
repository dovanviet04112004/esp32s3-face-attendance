import { Body, Controller, Delete, Get, HttpStatus, Param, Post, Query, UseGuards } from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import type { NoticeChannel, NoticeKind, Notification, NotificationPreference } from "@prisma/client";

import { Roles } from "../../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { CurrentViewer, type Viewer } from "../../common/scope/viewer.js";
import { API_AUTH, ApiErrors } from "../../common/decorators/api-docs.decorator.js";
import { ErrorBody } from "../../common/dto/error-body.dto.js";
import {
  DoneView,
  ListNoticesDto,
  NoticeView,
  PreferenceView,
  SetPreferenceDto,
  SubscribeDto,
  SubscriptionView,
  SweepView,
  UnreadView,
  UnsubscribeQueryDto,
} from "./dto/notifications.dto.js";
import { ContractAlertsService } from "./contract-alerts.service.js";
import { NotificationsService, type SubscriptionView as KeptSubscription, type Unread } from "./notifications.service.js";

@ApiTags("notifications")
@ApiBearerAuth(API_AUTH.user)
@ApiErrors(HttpStatus.UNAUTHORIZED)
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("notifications")
export class NotificationsController {
  constructor(
    private readonly notices: NotificationsService,
    private readonly alerts: ContractAlertsService,
  ) {}

  @Get()
  @ApiOperation({ summary: "This viewer's notices, newest first, fifty at most" })
  @ApiOkResponse({ type: [NoticeView] })
  list(@CurrentViewer() viewer: Viewer, @Query() query: ListNoticesDto): Promise<Notification[]> {
    return this.notices.list(viewer.userId, query.unread === true);
  }

  @Get("unread")
  @ApiOperation({ summary: "How many are waiting, for the bell" })
  @ApiOkResponse({ type: UnreadView })
  unread(@CurrentViewer() viewer: Viewer): Promise<Unread> {
    return this.notices.unread(viewer.userId);
  }

  @Post("read")
  @ApiOperation({ summary: "Mark everything read" })
  @ApiCreatedResponse({ type: UnreadView })
  readAll(@CurrentViewer() viewer: Viewer): Promise<Unread> {
    return this.notices.markRead(viewer.userId);
  }

  @Post(":id/read")
  @ApiOperation({ summary: "Mark one read" })
  @ApiCreatedResponse({ type: UnreadView })
  readOne(@CurrentViewer() viewer: Viewer, @Param("id") id: string): Promise<Unread> {
    return this.notices.markRead(viewer.userId, id);
  }

  @Post("sweep-contracts")
  @Roles("ADMIN")
  @ApiOperation({ summary: "Run the daily contract sweep now; it also runs at 07:00" })
  @ApiCreatedResponse({ type: SweepView })
  sweep(): Promise<{ told: number }> {
    return this.alerts.sweep();
  }

  @Get("preferences")
  @ApiOperation({ summary: "Six kinds across the two channels somebody delivers, defaults filled in" })
  @ApiOkResponse({ type: [PreferenceView] })
  preferences(
    @CurrentViewer() viewer: Viewer,
  ): Promise<{ kind: NoticeKind; channel: NoticeChannel; on: boolean }[]> {
    return this.notices.preferences(viewer.userId);
  }

  @Post("preferences")
  @ApiOperation({ summary: "Turn one kind on one channel on or off" })
  @ApiCreatedResponse({ type: PreferenceView })
  setPreference(
    @CurrentViewer() viewer: Viewer,
    @Body() body: SetPreferenceDto,
  ): Promise<NotificationPreference> {
    return this.notices.setPreference(viewer.userId, body);
  }

  @Post("subscribe")
  @ApiOperation({ summary: "Register this device for push; an endpoint another account holds stays with it" })
  @ApiCreatedResponse({ type: SubscriptionView })
  @ApiBadRequestResponse({ type: ErrorBody, description: "PUSH_ENDPOINT_REFUSED: not a known push service" })
  @ApiConflictResponse({ type: ErrorBody, description: "PUSH_ENDPOINT_TAKEN" })
  subscribe(@CurrentViewer() viewer: Viewer, @Body() body: SubscribeDto): Promise<KeptSubscription> {
    return this.notices.subscribe(viewer.userId, body);
  }

  @Delete("subscribe")
  @ApiOperation({ summary: "Drop this device, leaving the person's others alone" })
  @ApiOkResponse({ type: DoneView })
  @ApiBadRequestResponse({ type: ErrorBody, description: "PUSH_ENDPOINT_REQUIRED" })
  async unsubscribe(
    @CurrentViewer() viewer: Viewer,
    @Query() query: UnsubscribeQueryDto,
  ): Promise<{ done: true }> {
    await this.notices.unsubscribe(viewer, query.endpoint);
    return { done: true };
  }
}
