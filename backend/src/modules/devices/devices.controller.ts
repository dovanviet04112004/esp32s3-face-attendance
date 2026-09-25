import { Body, Controller, Get, HttpStatus, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiOperation, ApiTags } from "@nestjs/swagger";

import { ApiErrors } from "../../common/decorators/api-docs.decorator.js";
import { AuditedInService } from "../../common/decorators/audited.decorator.js";
import { Roles } from "../../common/decorators/roles.decorator.js";
import type { Page } from "../../common/dto/pagination.dto.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { CurrentViewer, type Viewer } from "../../common/scope/viewer.js";
import { DevicesService, type DeviceCounts, type PublicDevice } from "./devices.service.js";
import {
  ApproveDeviceDto,
  DeviceCountsView,
  DevicePageView,
  DeviceView,
  ListDevicesDto,
  UpdateDeviceDto,
} from "./dto/device.dto.js";

@ApiTags("devices")
@ApiBearerAuth()
@ApiErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN, HttpStatus.NOT_FOUND)
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("devices")
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Get()
  @Roles("ADMIN")
  @ApiOperation({ summary: "List kiosks, machines waiting for approval first; searchable, paged" })
  @ApiOkResponse({ type: DevicePageView })
  list(@Query() query: ListDevicesDto): Promise<Page<PublicDevice>> {
    return this.devices.list(query);
  }

  @Get("counts")
  @Roles("ADMIN")
  @ApiOperation({ summary: "How many kiosks stand in each status" })
  @ApiOkResponse({ type: DeviceCountsView })
  counts(): Promise<DeviceCounts> {
    return this.devices.counts();
  }

  @Get(":id")
  @Roles("ADMIN")
  @ApiOperation({ summary: "One kiosk and what it last reported" })
  @ApiOkResponse({ type: DeviceView })
  get(@Param("id") id: string): Promise<PublicDevice> {
    return this.devices.get(id);
  }

  @Patch(":id")
  @Roles("ADMIN")
  @ApiOperation({ summary: "Rename a kiosk or move it to another door" })
  @ApiOkResponse({ type: DeviceView })
  update(@Param("id") id: string, @Body() body: UpdateDeviceDto): Promise<PublicDevice> {
    return this.devices.update(id, body);
  }

  @Post(":id/approve")
  @AuditedInService()
  @Roles("ADMIN")
  @ApiOperation({ summary: "Accept a kiosk after matching the claim code on its screen" })
  @ApiCreatedResponse({ type: DeviceView })
  @ApiErrors(HttpStatus.CONFLICT)
  approve(
    @CurrentViewer() viewer: Viewer,
    @Param("id") id: string,
    @Body() body: ApproveDeviceDto,
  ): Promise<PublicDevice> {
    return this.devices.approve(id, body, viewer.userId);
  }

  @Post(":id/revoke")
  @AuditedInService()
  @Roles("ADMIN")
  @ApiOperation({ summary: "Take a kiosk back; it returns to waiting" })
  @ApiCreatedResponse({ type: DeviceView })
  revoke(@CurrentViewer() viewer: Viewer, @Param("id") id: string): Promise<PublicDevice> {
    return this.devices.revoke(id, viewer.userId);
  }
}
