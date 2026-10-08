import { Injectable, type ExecutionContext } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";
import type { Request } from "express";
import type { Observable } from "rxjs";

import { REFRESH_COOKIE } from "../../modules/auth/auth.types.js";
import { vouchedFor } from "./jwt-auth.guard.js";

/** Checks the refresh cookie; a request without one passes with no user, for the route to say nobody is signed in (KEHOACH 7.2). */
@Injectable()
export class JwtRefreshGuard extends AuthGuard("jwt-refresh") {
  override canActivate(context: ExecutionContext): boolean | Promise<boolean> | Observable<boolean> {
    const jar = context.switchToHttp().getRequest<Request>().cookies as Record<string, string> | undefined;
    return jar?.[REFRESH_COOKIE] ? super.canActivate(context) : true;
  }

  override handleRequest<T>(error: unknown, user: T): T {
    return vouchedFor(error, user);
  }
}
