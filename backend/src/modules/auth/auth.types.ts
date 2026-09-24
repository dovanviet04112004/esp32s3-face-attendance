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

/** Raised when every session of these accounts closes, so open sockets close with them (KEHOACH 9.23). */
export const SESSIONS_CUT = "auth.sessionsCut";

export interface SessionsCut {
  userIds: string[];
}

export const THROTTLE = {
  api: "api",
  heavy: "heavy",
  login: "login",
  deviceRegister: "deviceRegister",
  forgot: "forgot",
} as const;
