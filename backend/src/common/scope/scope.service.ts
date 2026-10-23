import { ConflictException, ForbiddenException, Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";

import { PrismaService } from "../../database/prisma.service.js";
import { CACHE, SCOPE_PREFIX } from "../cache/cache-keys.js";
import { CacheService } from "../cache/cache.service.js";
import type { Viewer } from "./viewer.js";

// VIEWER is the default on a fresh account, so it narrows like EMPLOYEE does:
// a role nobody assigned must not read the company (KEHOACH 9.4).
const UNSCOPED: ReadonlySet<string> = new Set(["ADMIN", "HR", "PAYROLL"]);
const MAX_DEPTH = 64;
const MANAGER_TREE_LOCK_KEY = 76;

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

  async peopleOf(entityIds: string[], own: number | null): Promise<number[]> {
    const rows = await this.db.employee.findMany({
      where: { OR: [{ legalEntityId: { in: entityIds } }, ...(own === null ? [] : [{ id: own }])] },
      select: { id: true },
    });
    return rows.map((row) => row.id);
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

  /** A loop makes the walk above return the whole ring; refuse to make one, the tree locked to the commit so a racing move walks after it. */
  async assertNoManagerCycle(tx: Prisma.TransactionClient, employeeIds: number[]): Promise<void> {
    if (employeeIds.length === 0) {
      return;
    }
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${MANAGER_TREE_LOCK_KEY}::int, 0)`;
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

  /** Whether a viewer who sees `visible` sees this employee; null sees everyone. */
  static sees(visible: number[] | null, employeeId: number): boolean {
    return visible === null || visible.includes(employeeId);
  }

  /** The people a viewer reaches, as a filter on Employee: its list, its desk's entities, or everyone. */
  static peopleWhere(viewer: Viewer, visible: number[] | null): Prisma.EmployeeWhereInput {
    if (visible !== null) {
      return { id: { in: visible } };
    }
    return viewer.entityIds === null ? {} : { legalEntityId: { in: viewer.entityIds } };
  }

  /** Rows owned by the people a viewer reaches; a limited desk keeps its own rows too (KEHOACH 9.4). */
  static ownedWhere(viewer: Viewer, visible: number[] | null): OwnedWhere {
    if (visible !== null) {
      return { employeeId: { in: visible } };
    }
    if (viewer.entityIds === null) {
      return {};
    }
    const ofEntities = { legalEntityId: { in: viewer.entityIds } };
    return { employee: viewer.employeeId === null ? ofEntities : { OR: [ofEntities, { id: viewer.employeeId }] } };
  }

  static peopleSql(viewer: Viewer, visible: number[] | null, id: Prisma.Sql, entity: Prisma.Sql): Prisma.Sql {
    if (visible !== null) {
      return Prisma.sql`${id} = ANY(${visible}::int[])`;
    }
    return viewer.entityIds === null ? Prisma.sql`TRUE` : Prisma.sql`${entity} = ANY(${viewer.entityIds}::text[])`;
  }

  /** Whether a viewer who sees `visible` reaches this employee, a limited desk by the employee's entity. */
  async reaches(viewer: Viewer, visible: number[] | null, employeeId: number): Promise<boolean> {
    if (visible !== null) {
      return visible.includes(employeeId);
    }
    if (viewer.entityIds === null || employeeId === viewer.employeeId) {
      return true;
    }
    const person = await this.db.employee.findUnique({ where: { id: employeeId }, select: { legalEntityId: true } });
    return person !== null && viewer.entityIds.includes(person.legalEntityId);
  }

  /** Whether a viewer reaches a row of this entity; a row with none belongs to the whole group and is read by all. */
  static reachesEntity(viewer: Viewer, entityId: string | null): boolean {
    return viewer.entityIds === null || entityId === null || viewer.entityIds.includes(entityId);
  }

  /** Rows that carry an entity, narrowed for a limited desk; group-wide rows stay in when asked for. */
  static entityWhere(viewer: Viewer, groupRows: boolean): { legalEntityId?: { in: string[] } } | object {
    if (viewer.entityIds === null) {
      return {};
    }
    const own = { legalEntityId: { in: viewer.entityIds } };
    return groupRows ? { OR: [own, { legalEntityId: null }] } : own;
  }

  /** Refuse a write to a group-wide row from a desk held to some entities (KEHOACH 9.4). */
  static mustWriteGroup(viewer: Viewer): void {
    if (viewer.entityIds !== null) {
      throw new ForbiddenException("GROUP_WIDE_ONLY");
    }
  }
}

export type OwnedWhere = { employeeId?: { in: number[] }; employee?: Prisma.EmployeeWhereInput };
