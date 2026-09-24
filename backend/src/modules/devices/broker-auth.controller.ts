import { Body, Controller, HttpCode, HttpStatus, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";

import { NotAudited } from "../../common/decorators/audited.decorator.js";
import { AuthService } from "../auth/auth.service.js";
import { THROTTLE } from "../auth/auth.types.js";
import { isServiceName } from "./devices.service.js";
import { BrokerLoginDto } from "./dto/device.dto.js";

export interface BrokerVerdict {
  result: "allow" | "deny";
}

/** EMQX asking about a kiosk login; traefik keeps it off the internet (KEHOACH 7.4). */
@ApiTags("devices")
@Controller("mqtt")
export class BrokerAuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("auth")
  @HttpCode(HttpStatus.OK)
  @NotAudited()
  // The caller is the broker inside compose, speaking for the whole fleet (KEHOACH 7.2).
  @SkipThrottle({ [THROTTLE.api]: true })
  @ApiOperation({ summary: "Whether a kiosk may log in to the broker" })
  async check(@Body() body: BrokerLoginDto): Promise<BrokerVerdict> {
    // A ticket owns one client id, and a service name logs in only from the broker's table (KEHOACH 7.4).
    if (body.clientid !== body.username || isServiceName(body.username)) {
      return { result: "deny" };
    }
    const admitted = await this.auth.admitDevice(body.username, body.password);
    return { result: admitted ? "allow" : "deny" };
  }
}
