import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";

import type { Env } from "../../../config/env.schema.js";
import type { AccessClaims } from "../auth.types.js";

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, "jwt") {
  constructor(config: ConfigService<Env, true>) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.get("JWT_ACCESS_SECRET", { infer: true }),
      ignoreExpiration: false,
    });
  }

  validate(claims: AccessClaims): AccessClaims {
    return claims;
  }
}
