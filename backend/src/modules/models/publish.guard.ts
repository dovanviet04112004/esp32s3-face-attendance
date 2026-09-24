import { createHash, timingSafeEqual } from "node:crypto";

import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Request } from "express";

import type { Env } from "../../config/env.schema.js";

const BEARER = "Bearer ";

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

/** Lets through the publisher holding RELEASE_PUBLISH_TOKEN; no person ever uses this door (KEHOACH 7.7). */
@Injectable()
export class PublishGuard implements CanActivate {
  constructor(private readonly config: ConfigService<Env, true>) {}

  canActivate(context: ExecutionContext): boolean {
    const want = this.config.get("RELEASE_PUBLISH_TOKEN", { infer: true });
    if (!want) {
      throw new ForbiddenException("PUBLISHING_OFF");
    }
    const header = context.switchToHttp().getRequest<Request>().headers.authorization ?? "";
    const given = header.startsWith(BEARER) ? header.slice(BEARER.length) : "";
    // Equal-length digests, so the comparison takes the same time whatever arrives.
    if (!timingSafeEqual(digest(given), digest(want))) {
      throw new UnauthorizedException("PUBLISH_TOKEN_REJECTED");
    }
    return true;
  }
}
