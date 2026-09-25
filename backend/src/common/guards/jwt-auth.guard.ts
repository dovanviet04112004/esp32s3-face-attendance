import { Injectable, UnauthorizedException } from "@nestjs/common";
import { AuthGuard } from "@nestjs/passport";

/** Pass a strategy's own refusal through, and name passport's wordless one (CLAUDE.md 3.1 rule 2). */
export function vouchedFor<T>(error: unknown, user: T | false | null | undefined): T {
  if (error) {
    throw error;
  }
  if (!user) {
    throw new UnauthorizedException("UNAUTHENTICATED");
  }
  return user;
}

@Injectable()
export class JwtAuthGuard extends AuthGuard("jwt") {
  override handleRequest<T>(error: unknown, user: T): T {
    return vouchedFor(error, user);
  }
}
