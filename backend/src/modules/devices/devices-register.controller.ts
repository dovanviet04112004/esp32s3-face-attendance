import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { ApiOperation, ApiResponse, ApiTags } from "@nestjs/swagger";
import type { Request, Response } from "express";
import { ExtractJwt } from "passport-jwt";

import { RateBucket } from "../../common/decorators/rate-bucket.decorator.js";
import { DeviceAuthGuard } from "../../common/guards/device-auth.guard.js";
import { THROTTLE, type DeviceClaims } from "../auth/auth.types.js";
import { DevicesService, type Registration } from "./devices.service.js";
import { RegisterDeviceDto } from "./dto/device.dto.js";

const bearer = ExtractJwt.fromAuthHeaderAsBearerToken();

/** A controller of its own so the guards on the rest of `devices` are not
 *  loosened to let an uncredentialled machine through (KEHOACH 7.3). */
@ApiTags("devices")
@Controller("devices")
export class DevicesRegisterController {
  constructor(private readonly devices: DevicesService) {}

  @Post("register")
  @RateBucket(THROTTLE.deviceRegister)
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

  @Get("me")
  @UseGuards(DeviceAuthGuard)
  @ApiOperation({ summary: "A kiosk asking whether its ticket still stands (KEHOACH 7.3)" })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: "Revoked, replaced or expired" })
  mine(@Req() req: Request & { user: DeviceClaims }): { deviceId: string } {
    return { deviceId: req.user.deviceId };
  }

  @Post("me/token")
  @UseGuards(DeviceAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "A kiosk trading the ticket it holds for a fresh one (KEHOACH 7.3)" })
  @ApiResponse({ status: HttpStatus.OK, description: "Carries the new device token" })
  @ApiResponse({ status: HttpStatus.UNAUTHORIZED, description: "Revoked, replaced or expired" })
  renew(@Req() req: Request & { user: DeviceClaims }): Promise<Registration> {
    return this.devices.renew(req.user.deviceId, bearer(req) ?? "");
  }
}
