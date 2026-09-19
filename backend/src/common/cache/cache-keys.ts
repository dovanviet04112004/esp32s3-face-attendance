/** Every cache key and its lifetime, declared once (KEHOACH 4.9). */
export const CACHE = {
  employee: (id: number) => ({ key: `emp:${id}`, ttlSeconds: 600 }),
  employeeList: (hash: string) => ({ key: `emp:list:${hash}`, ttlSeconds: 60 }),
  deviceStatus: (id: string) => ({ key: `dev:${id}:status`, ttlSeconds: 45 }),
  report: (type: string, range: string) => ({ key: `report:${type}:${range}`, ttlSeconds: 900 }),
  activeShifts: () => ({ key: "shift:active", ttlSeconds: 1800 }),
  reportsTo: (employeeId: number) => ({ key: `scope:under:${employeeId}`, ttlSeconds: 300 }),
} as const;

/** What a cached entry is allowed to be: anything Postgres can rebuild. */
export interface CacheEntry {
  key: string;
  ttlSeconds: number;
}
