import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";

import type { Env } from "../../../config/env.schema.js";
import { AuthService } from "../auth.service.js";
import type { AccessClaims } from "../auth.types.js";

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, "jwt") {
  constructor(
    config: ConfigService<Env, true>,
    private readonly auth: AuthService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.get("JWT_ACCESS_SECRET", { infer: true }),
      ignoreExpiration: false,
    });
  }

  // A signature outlives a demotion or a leave; the cutoff says the token died with its sessions.
  async validate(claims: AccessClaims & { iat?: number }): Promise<AccessClaims> {
    if (await this.auth.accessCut(claims.sub, claims.iat ?? 0)) {
      throw new UnauthorizedException("SESSION_CLOSED");
    }
    return claims;
  }
}
