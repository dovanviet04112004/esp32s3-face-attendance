import { Body, Controller, Delete, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { NoticeChannel, NoticeKind, Notification } from "@prisma/client";

import { Roles } from "../../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { CurrentViewer, type Viewer } from "../../common/scope/viewer.js";
import { SetPreferenceDto, SubscribeDto } from "./dto/notifications.dto.js";
import { ContractAlertsService } from "./contract-alerts.service.js";
import { NotificationsService, type Unread } from "./notifications.service.js";

const NOBODY = 0;

@ApiTags("notifications")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("notifications")
export class NotificationsController {
  constructor(
    private readonly notices: NotificationsService,
    private readonly alerts: ContractAlertsService,
  ) {}

  @Get()
  @ApiOperation({ summary: "This viewer's notices, newest first" })
  list(
    @CurrentViewer() viewer: Viewer,
    @Query("unread") unread?: string,
  ): Promise<Notification[]> {
    return this.notices.list(viewer.employeeId ?? NOBODY, unread === "true");
  }

  @Get("unread")
  @ApiOperation({ summary: "How many are waiting, for the bell" })
  unread(@CurrentViewer() viewer: Viewer): Promise<Unread> {
    return this.notices.unread(viewer.employeeId ?? NOBODY);
  }

  @Post("read")
  @ApiOperation({ summary: "Mark everything read" })
  readAll(@CurrentViewer() viewer: Viewer): Promise<Unread> {
    return this.notices.markRead(viewer.employeeId ?? NOBODY);
  }

  @Post(":id/read")
  @ApiOperation({ summary: "Mark one read" })
  readOne(@CurrentViewer() viewer: Viewer, @Param("id") id: string): Promise<Unread> {
    return this.notices.markRead(viewer.employeeId ?? NOBODY, id);
  }

  @Post("sweep-contracts")
  @Roles("ADMIN")
  @ApiOperation({ summary: "Run the daily contract sweep now; it also runs at 07:00" })
  sweep(): Promise<{ told: number }> {
    return this.alerts.sweep();
  }

  @Get("preferences")
  @ApiOperation({ summary: "Four kinds across three channels, with the defaults filled in" })
  preferences(
    @CurrentViewer() viewer: Viewer,
  ): Promise<{ kind: NoticeKind; channel: NoticeChannel; on: boolean }[]> {
    return this.notices.preferences(viewer.employeeId ?? NOBODY);
  }

  @Post("preferences")
  @ApiOperation({ summary: "Turn one kind on one channel on or off" })
  setPreference(
    @CurrentViewer() viewer: Viewer,
    @Body() body: SetPreferenceDto,
  ): Promise<unknown> {
    return this.notices.setPreference(viewer.employeeId ?? NOBODY, body);
  }

  @Post("subscribe")
  @ApiOperation({ summary: "Register this device for push" })
  subscribe(@CurrentViewer() viewer: Viewer, @Body() body: SubscribeDto): Promise<unknown> {
    return this.notices.subscribe(viewer.employeeId ?? NOBODY, body);
  }

  @Delete("subscribe")
  @ApiOperation({ summary: "Drop this device, leaving the person's others alone" })
  async unsubscribe(@Query("endpoint") endpoint: string): Promise<{ done: true }> {
    await this.notices.unsubscribe(endpoint);
    return { done: true };
  }
}
