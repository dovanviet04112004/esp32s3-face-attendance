import { SetMetadata } from "@nestjs/common";
import type { Role } from "@prisma/client";

export const ROLES_KEY = "roles";

/** Restrict a route to these roles; RolesGuard reads the list back. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
