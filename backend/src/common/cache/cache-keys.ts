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
  addressMisses: (address: string) => `auth:ipmiss:${address}`,
  accessCutoff: (userId: string) => `auth:cutoff:${userId}`,
} as const;

/** Rate counters, one per bucket and caller across every route that names the bucket (KEHOACH 7.2). */
export const RATE = {
  hits: (bucket: string, caller: string) => `rate:${bucket}:${caller}`,
  block: (bucket: string, caller: string) => `rate:${bucket}:${caller}:block`,
} as const;

/** Passes and sessions for the API reference: losing one closes it early, never opens it (KEHOACH 7.2). */
export const DOCS = {
  pass: (pass: string) => ({ key: `docs:pass:${pass}`, ttlSeconds: 60 }),
  session: (id: string) => ({ key: `docs:session:${id}`, ttlSeconds: 900 }),
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
