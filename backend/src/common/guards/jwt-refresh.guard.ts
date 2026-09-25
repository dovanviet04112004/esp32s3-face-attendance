import { Injectable } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";

import { vouchedFor } from "./jwt-auth.guard.js";

@Injectable()
export class JwtRefreshGuard extends AuthGuard("jwt-refresh") {
  override handleRequest<T>(error: unknown, user: T): T {
    return vouchedFor(error, user);
  }
}
