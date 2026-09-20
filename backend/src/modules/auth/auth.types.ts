import type { Role } from "@prisma/client";

/** What a guarded handler sees; employeeId saves row scope a lookup (KEHOACH 9.4). */
export interface AccessClaims {
  sub: string;
  role: Role;
  sid: string;
  employeeId?: number;
}

/** What a refresh token carries; sid names the row, jti the token it accepts. */
export interface RefreshClaims {
  sub: string;
  sid: string;
  jti: string;
}

export interface DeviceClaims {
  deviceId: string;
  serial?: string;
}

export const REFRESH_COOKIE = "kiosk_refresh";
