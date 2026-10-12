import { Prisma } from "@prisma/client";

import type { PrismaService } from "../../database/prisma.service.js";

/** A department and every department under it, as a subquery for `IN (...)`. */
export function branchOf(departmentId: string): Prisma.Sql {
  return Prisma.sql`
    WITH RECURSIVE branch AS (
      SELECT "id" FROM "Department" WHERE "id" = ${departmentId}
      UNION
      SELECT c."id" FROM "Department" c JOIN branch b ON c."parentId" = b."id"
    )
    SELECT "id" FROM branch`;
}

/** A department and every department under it, however deep (KEHOACH 4.6). */
export async function departmentSubtree(db: PrismaService, rootId: string): Promise<string[]> {
  const rows = await db.$queryRaw<{ id: string }[]>(branchOf(rootId));
  return rows.map((row) => row.id);
}
