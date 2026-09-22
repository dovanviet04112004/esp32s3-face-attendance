import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import { Roles } from "../../common/decorators/roles.decorator.js";
import type { Page } from "../../common/dto/pagination.dto.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { DevicesService, type PublicDevice } from "./devices.service.js";
import { ApproveDeviceDto, ListDevicesDto, UpdateDeviceDto } from "./dto/device.dto.js";

@ApiTags("devices")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("devices")
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Get()
  @Roles("ADMIN")
  @ApiOperation({ summary: "List kiosks, machines waiting for approval first" })
  list(@Query() query: ListDevicesDto): Promise<Page<PublicDevice>> {
    return this.devices.list(query);
  }

  @Get(":id")
  @Roles("ADMIN")
  @ApiOperation({ summary: "One kiosk and what it last reported" })
  get(@Param("id") id: string): Promise<PublicDevice> {
    return this.devices.get(id);
  }

  @Patch(":id")
  @Roles("ADMIN")
  @ApiOperation({ summary: "Rename a kiosk or move it to another door" })
  update(@Param("id") id: string, @Body() body: UpdateDeviceDto): Promise<PublicDevice> {
    return this.devices.update(id, body);
  }

  @Post(":id/approve")
  @Roles("ADMIN")
  @ApiOperation({ summary: "Accept a kiosk after matching the id on its screen" })
  approve(@Param("id") id: string, @Body() body: ApproveDeviceDto): Promise<PublicDevice> {
    return this.devices.approve(id, body);
  }

  @Post(":id/revoke")
  @Roles("ADMIN")
  @ApiOperation({ summary: "Take a kiosk back; it returns to waiting" })
  revoke(@Param("id") id: string): Promise<PublicDevice> {
    return this.devices.revoke(id);
  }
}
