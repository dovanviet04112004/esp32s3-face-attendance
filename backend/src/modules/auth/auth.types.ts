import type { Role } from "@prisma/client";

/** What a guarded handler sees; employeeId saves row scope a lookup (KEHOACH 9.4). */
export interface AccessClaims {
  sub: string;
  role: Role;
  employeeId?: number;
}

/** What a refresh token carries; jti is the half the database can revoke. */
export interface RefreshClaims {
  sub: string;
  jti: string;
}

/** What a kiosk token carries once E13-T9 issues one. */
export interface DeviceClaims {
  deviceId: string;
  serial?: string;
}

export const REFRESH_COOKIE = "kiosk_refresh";
