import { Injectable } from "@nestjs/common";

import { PrismaService } from "../../database/prisma.service.js";
import { CACHE } from "../cache/cache-keys.js";
import { CacheService } from "../cache/cache.service.js";
import type { Viewer } from "./viewer.js";

const UNSCOPED: ReadonlySet<string> = new Set(["ADMIN", "HR", "PAYROLL", "VIEWER"]);

@Injectable()
export class ScopeService {
  constructor(
    private readonly db: PrismaService,
    private readonly cache: CacheService,
  ) {}

  /** Which employees this viewer may see; null is everyone (KEHOACH 9.4). */
  async visibleEmployeeIds(viewer: Viewer): Promise<number[] | null> {
    if (UNSCOPED.has(viewer.role)) {
      return null;
    }
    if (viewer.employeeId === null) {
      return [];
    }
    if (viewer.role !== "MANAGER") {
      return [viewer.employeeId];
    }
    return this.subtree(viewer.employeeId);
  }

  /** A manager and everyone under them, however deep. */
  async subtree(rootEmployeeId: number): Promise<number[]> {
    return this.cache.through(CACHE.reportsTo(rootEmployeeId), async () => {
      const rows = await this.db.$queryRaw<{ id: number }[]>`
        WITH RECURSIVE below AS (
          SELECT "id" FROM "Employee" WHERE "id" = ${rootEmployeeId}
          UNION ALL
          SELECT e."id" FROM "Employee" e JOIN below b ON e."managerId" = b."id"
        )
        SELECT "id" FROM below
      `;
      return rows.map((row) => row.id);
    });
  }

  /** Fold a scope into a where clause; null ids narrow nothing. */
  static narrow<T extends string>(field: T, ids: number[] | null): Record<T, { in: number[] }> | object {
    return ids === null ? {} : ({ [field]: { in: ids } } as Record<T, { in: number[] }>);
  }
}
