import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";

import type { Env } from "../../../config/env.schema.js";
import type { DeviceClaims } from "../auth.types.js";

/** A kiosk token is signed apart, so holding one opens no web session. */
@Injectable()
export class DeviceStrategy extends PassportStrategy(Strategy, "device") {
  constructor(config: ConfigService<Env, true>) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.get("JWT_DEVICE_SECRET", { infer: true }),
      ignoreExpiration: false,
    });
  }

  validate(claims: DeviceClaims): DeviceClaims {
    return claims;
  }
}
