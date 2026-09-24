import { Body, Controller, HttpCode, HttpStatus, Post } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";

import { NotAudited } from "../../common/decorators/audited.decorator.js";
import { AuthService } from "../auth/auth.service.js";
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
  @ApiOperation({ summary: "Whether a kiosk may log in to the broker" })
  async check(@Body() body: BrokerLoginDto): Promise<BrokerVerdict> {
    // One client id per ticket, or a valid ticket takes over another kiosk's session.
    if (body.clientid !== body.username) {
      return { result: "deny" };
    }
    const admitted = await this.auth.admitDevice(body.username, body.password);
    return { result: admitted ? "allow" : "deny" };
  }
}
