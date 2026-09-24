import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import type { Request } from "express";
import { ExtractJwt, Strategy } from "passport-jwt";

import type { Env } from "../../../config/env.schema.js";
import { AuthService } from "../auth.service.js";
import type { DeviceClaims } from "../auth.types.js";

const bearer = ExtractJwt.fromAuthHeaderAsBearerToken();

/** A kiosk token is signed apart, so holding one opens no web session. */
@Injectable()
export class DeviceStrategy extends PassportStrategy(Strategy, "device") {
  constructor(
    config: ConfigService<Env, true>,
    private readonly auth: AuthService,
  ) {
    super({
      jwtFromRequest: bearer,
      secretOrKey: config.get("JWT_DEVICE_SECRET", { infer: true }),
      ignoreExpiration: false,
      passReqToCallback: true,
    });
  }

  // A signature outlives a revoke; the device row is what says the ticket still stands.
  async validate(req: Request, claims: DeviceClaims): Promise<DeviceClaims> {
    if (!(await this.auth.admitDevice(claims.deviceId, bearer(req) ?? ""))) {
      throw new UnauthorizedException("DEVICE_TOKEN_REJECTED");
    }
    return claims;
  }
}
