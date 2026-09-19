import { CanActivate, ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Role } from "@prisma/client";

import { ROLES_KEY } from "../decorators/roles.decorator.js";

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
    const { user } = context.switchToHttp().getRequest<{ user?: { role?: Role } }>();
    return user?.role !== undefined && wanted.includes(user.role);
  }
}
