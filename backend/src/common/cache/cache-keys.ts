/** What every scope key starts with, so dropping the set needs no guesswork. */
export const SCOPE_PREFIX = "scope:under:";

/** Every cache key and its lifetime, declared once (KEHOACH 4.9). */
export const CACHE = {
  employee: (id: number) => ({ key: `emp:${id}`, ttlSeconds: 600 }),
  employeeList: (hash: string) => ({ key: `emp:list:${hash}`, ttlSeconds: 60 }),
  deviceStatus: (id: string) => ({ key: `dev:${id}:status`, ttlSeconds: 45 }),
  // The scope belongs in the key: a narrowed answer cached under a bare
  // range would be served back to somebody who sees more (KEHOACH 9.4).
  report: (type: string, range: string, scope = "all") => ({
    key: `report:${type}:${scope}:${range}`,
    ttlSeconds: 900,
  }),
  activeShifts: () => ({ key: "shift:active", ttlSeconds: 1800 }),
  reportsTo: (employeeId: number) => ({ key: `${SCOPE_PREFIX}${employeeId}`, ttlSeconds: 300 }),
} as const;

/** Counters guarding a door, not a cache of rows: losing one lifts a lock early and never locks anyone (KEHOACH 7.2). */
export const GUARD = {
  loginMisses: (emailHash: string) => `auth:miss:${emailHash}`,
  loginLock: (emailHash: string) => `auth:lock:${emailHash}`,
  accessCutoff: (userId: string) => `auth:cutoff:${userId}`,
} as const;

/** Reminders already sent: losing one sends the mail again, never skips it (KEHOACH 4.8). */
export const ALARM = {
  backup: (problem: string) => `ops:backup-alarm:${problem}`,
} as const;

/** What a cached entry is allowed to be: anything Postgres can rebuild. */
export interface CacheEntry {
  key: string;
  ttlSeconds: number;
}
