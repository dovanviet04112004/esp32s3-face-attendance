import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Device } from "@prisma/client";

import { Roles } from "../../common/decorators/roles.decorator.js";
import type { Page } from "../../common/dto/pagination.dto.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { DevicesService } from "./devices.service.js";
import { ApproveDeviceDto, ListDevicesDto, UpdateDeviceDto } from "./dto/device.dto.js";

@ApiTags("devices")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("devices")
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Get()
  @ApiOperation({ summary: "List kiosks, machines waiting for approval first" })
  list(@Query() query: ListDevicesDto): Promise<Page<Device>> {
    return this.devices.list(query);
  }

  @Get(":id")
  get(@Param("id") id: string): Promise<Device> {
    return this.devices.get(id);
  }

  @Patch(":id")
  @Roles("ADMIN")
  update(@Param("id") id: string, @Body() body: UpdateDeviceDto): Promise<Device> {
    return this.devices.update(id, body);
  }

  @Post(":id/approve")
  @Roles("ADMIN")
  @ApiOperation({ summary: "Accept a kiosk after matching the id on its screen" })
  approve(@Param("id") id: string, @Body() body: ApproveDeviceDto): Promise<Device> {
    return this.devices.approve(id, body);
  }

  @Post(":id/revoke")
  @Roles("ADMIN")
  @ApiOperation({ summary: "Take a kiosk back; it returns to waiting" })
  revoke(@Param("id") id: string): Promise<Device> {
    return this.devices.revoke(id);
  }
}
