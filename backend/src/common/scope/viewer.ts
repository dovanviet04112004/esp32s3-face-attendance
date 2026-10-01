import { createParamDecorator, ForbiddenException, type ExecutionContext } from "@nestjs/common";
import type { Role } from "@prisma/client";

import type { AccessClaims } from "../../modules/auth/auth.types.js";

/** Who is asking; every HR service narrows its query by this. */
export interface Viewer {
  userId: string;
  role: Role;
  employeeId: number | null;
}

export const LINKED_DESKS: ReadonlySet<Role> = new Set<Role>(["HR", "PAYROLL"]);

export function isUnlinkedDesk(viewer: Viewer): boolean {
  return viewer.employeeId === null && LINKED_DESKS.has(viewer.role);
}

/** Refuse a decision about the viewer's own record, or by a desk account with none to compare (KEHOACH 9.4). */
export function refuseOwn(viewer: Viewer, ...employeeIds: number[]): void {
  if (viewer.employeeId !== null && employeeIds.includes(viewer.employeeId)) {
    throw new ForbiddenException("SELF_DECISION");
  }
  if (isUnlinkedDesk(viewer)) {
    throw new ForbiddenException("DESK_NEEDS_EMPLOYEE");
  }
}

/** The viewer a guarded handler serves; JwtAuthGuard has put the claims on the request. */
export const CurrentViewer = createParamDecorator((_data: unknown, context: ExecutionContext): Viewer => {
  const claims = context.switchToHttp().getRequest<{ user?: AccessClaims }>().user;
  return {
    userId: claims?.sub ?? "",
    role: claims?.role ?? "VIEWER",
    employeeId: claims?.employeeId ?? null,
  };
});
