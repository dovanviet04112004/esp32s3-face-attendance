import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PassportStrategy } from "@nestjs/passport";
import type { Request } from "express";
import { Strategy } from "passport-jwt";

import type { Env } from "../../../config/env.schema.js";
import { REFRESH_COOKIE, type RefreshClaims } from "../auth.types.js";

/** The refresh token rides in an httpOnly cookie, never in a header. */
function fromCookie(req: Request): string | null {
  const jar = req.cookies as Record<string, string> | undefined;
  return jar?.[REFRESH_COOKIE] ?? null;
}

@Injectable()
export class JwtRefreshStrategy extends PassportStrategy(Strategy, "jwt-refresh") {
  constructor(config: ConfigService<Env, true>) {
    super({
      jwtFromRequest: fromCookie,
      secretOrKey: config.get("JWT_REFRESH_SECRET", { infer: true }),
      ignoreExpiration: false,
    });
  }

  validate(claims: RefreshClaims): RefreshClaims {
    return claims;
  }
}
