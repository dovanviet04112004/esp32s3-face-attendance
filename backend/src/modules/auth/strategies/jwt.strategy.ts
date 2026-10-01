import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";

import type { Env } from "../../../config/env.schema.js";
import { AuthService } from "../auth.service.js";
import { JWT_ALGORITHM, type AccessClaims } from "../auth.types.js";
import { MfaService } from "../mfa.service.js";

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy, "jwt") {
  constructor(
    config: ConfigService<Env, true>,
    private readonly auth: AuthService,
    private readonly mfa: MfaService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.get("JWT_ACCESS_SECRET", { infer: true }),
      algorithms: [JWT_ALGORITHM],
      ignoreExpiration: false,
    });
  }

  // A signature outlives a demotion or a leave; the cutoff says the token died with its sessions.
  async validate(claims: AccessClaims & { iat?: number }): Promise<AccessClaims> {
    if (await this.auth.accessCut(claims, claims.iat ?? 0)) {
      throw new UnauthorizedException("SESSION_CLOSED");
    }
    if (this.mfa.missing(claims)) {
      throw new UnauthorizedException("MFA_REQUIRED");
    }
    return claims;
  }
}
