import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import type { Role } from "@prisma/client";

import type { AccessClaims } from "../../modules/auth/auth.types.js";

/** Who is asking; every HR service narrows its query by this. */
export interface Viewer {
  userId: string;
  role: Role;
  employeeId: number | null;
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
