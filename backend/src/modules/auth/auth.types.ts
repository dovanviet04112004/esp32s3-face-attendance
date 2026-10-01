import type { Role } from "@prisma/client";

/** What a guarded handler sees; employeeId saves row scope a lookup, mfa marks a session that gave its code (KEHOACH 9.4). */
export interface AccessClaims {
  sub: string;
  role: Role;
  sid: string;
  employeeId?: number;
  mfa?: true;
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

export const DOCS_PATH = "/docs";
export const DOCS_COOKIE = "kiosk_docs";

/** Raised when sessions close, all of an account's or only the named ones, so their sockets close too (KEHOACH 9.23). */
export const SESSIONS_CUT = "auth.sessionsCut";

export interface SessionsCut {
  userIds: string[];
  sessionIds?: string[];
}

export const JWT_ALGORITHM = "HS256";

export const THROTTLE = {
  api: "api",
  heavy: "heavy",
  search: "search",
  login: "login",
  deviceRegister: "deviceRegister",
  forgot: "forgot",
  mfa: "mfa",
} as const;
