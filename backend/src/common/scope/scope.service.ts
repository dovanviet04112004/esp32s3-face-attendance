import { ConflictException, Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";

import { PrismaService } from "../../database/prisma.service.js";
import { CACHE, SCOPE_PREFIX } from "../cache/cache-keys.js";
import { CacheService } from "../cache/cache.service.js";
import type { Viewer } from "./viewer.js";

// VIEWER is the default on a fresh account, so it narrows like EMPLOYEE does:
// a role nobody assigned must not read the company (KEHOACH 9.4).
const UNSCOPED: ReadonlySet<string> = new Set(["ADMIN", "HR", "PAYROLL"]);
const MAX_DEPTH = 64;

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

  /** Who this viewer sees on rows the tree is no party to (KEHOACH 9.15). */
  async deskOrSelfEmployeeIds(viewer: Viewer): Promise<number[] | null> {
    if (UNSCOPED.has(viewer.role)) {
      return null;
    }
    return viewer.employeeId === null ? [] : [viewer.employeeId];
  }

  /** A manager and everyone under them, however deep. */
  async subtree(rootEmployeeId: number): Promise<number[]> {
    return this.cache.through(CACHE.reportsTo(rootEmployeeId), async () => {
      const rows = await this.db.$queryRaw<{ id: number }[]>`
        WITH RECURSIVE below AS (
          SELECT "id" FROM "Employee" WHERE "id" = ${rootEmployeeId}
          UNION
          SELECT e."id" FROM "Employee" e JOIN below b ON e."managerId" = b."id"
        )
        SELECT "id" FROM below
      `;
      return rows.map((row) => row.id);
    });
  }

  /** Every key goes: one move reshapes every subtree above both its ends. */
  async forgetScopes(): Promise<void> {
    await this.cache.drop(SCOPE_PREFIX);
  }

  /** A loop makes the walk above return the whole ring; refuse to make one. */
  async assertNoManagerCycle(tx: Prisma.TransactionClient, employeeIds: number[]): Promise<void> {
    if (employeeIds.length === 0) {
      return;
    }
    const looped = await tx.$queryRaw<{ start: number }[]>`
      WITH RECURSIVE up AS (
        SELECT "id" AS "start", "managerId" AS "at", 1 AS "depth"
          FROM "Employee" WHERE "id" = ANY(${employeeIds}::int[])
        UNION ALL
        SELECT u."start", e."managerId", u."depth" + 1
          FROM up u JOIN "Employee" e ON e."id" = u."at"
         WHERE u."at" IS NOT NULL AND u."depth" < ${MAX_DEPTH}
      )
      SELECT DISTINCT "start" FROM up WHERE "at" = "start"
    `;
    if (looped.length > 0) {
      throw new ConflictException("MANAGER_CYCLE");
    }
  }

  static narrow<T extends string>(field: T, ids: number[] | null): Record<T, { in: number[] }> | object {
    return ids === null ? {} : ({ [field]: { in: ids } } as Record<T, { in: number[] }>);
  }
}
