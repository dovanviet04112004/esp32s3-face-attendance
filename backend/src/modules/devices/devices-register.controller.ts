import { Body, Controller, HttpStatus, Post, Res, UseGuards } from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import { SkipThrottle, ThrottlerGuard } from "@nestjs/throttler";
import type { Response } from "express";

import { THROTTLE } from "../auth/auth.types.js";
import { DevicesService, type Registration } from "./devices.service.js";
import { RegisterDeviceDto } from "./dto/device.dto.js";

/** A controller of its own so the guards on the rest of `devices` are not
 *  loosened to let an uncredentialled machine through (KEHOACH 7.3). */
@ApiTags("devices")
@Controller("devices")
export class DevicesRegisterController {
  constructor(private readonly devices: DevicesService) {}

  @Post("register")
  @UseGuards(ThrottlerGuard)
  @SkipThrottle({ [THROTTLE.login]: true })
  @ApiOperation({ summary: "A kiosk with an empty NVS asking to be let in" })
  @ApiResponse({ status: HttpStatus.ACCEPTED, description: "Waiting for a person to approve it" })
  @ApiResponse({ status: HttpStatus.OK, description: "Approved; carries the device token" })
  async register(
    @Body() body: RegisterDeviceDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<Registration> {
    const answer = await this.devices.register(body);
    res.status(answer.accepted ? HttpStatus.ACCEPTED : HttpStatus.OK);
    return answer;
  }
}
