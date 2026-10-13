import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Role } from "@prisma/client";

import type { AccessClaims } from "../../modules/auth/auth.types.js";
import { ROLES_KEY } from "../decorators/roles.decorator.js";
import { REACH_KEY, type ReachKind } from "../scope/reach.js";
import { heldEntities } from "../scope/viewer.js";

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const wanted = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    // A route that names no role is open to anyone the auth guard let through.
    if (!wanted?.length) {
      return true;
    }
    const { user, method } = context.switchToHttp().getRequest<{ user?: AccessClaims; method: string }>();
    if (user?.role === undefined || !wanted.includes(user.role)) {
      throw new ForbiddenException("FORBIDDEN_ROLE");
    }
    const reach = this.reflector.getAllAndOverride<ReachKind | undefined>(REACH_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    // A shared catalogue changes for every entity at once, so a desk held to some reads it only (KEHOACH 9.4).
    if (reach === "catalogue" && method !== "GET" && heldEntities(user.role, user.ent) !== null) {
      throw new ForbiddenException("GROUP_WIDE_ONLY");
    }
    return true;
  }
}
