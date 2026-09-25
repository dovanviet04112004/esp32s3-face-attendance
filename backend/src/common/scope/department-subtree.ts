import type { PrismaService } from "../../database/prisma.service.js";

/** A department and every department under it, however deep (KEHOACH 4.6). */
export async function departmentSubtree(db: PrismaService, rootId: string): Promise<string[]> {
  const rows = await db.$queryRaw<{ id: string }[]>`
    WITH RECURSIVE below AS (
      SELECT "id" FROM "Department" WHERE "id" = ${rootId}
      UNION
      SELECT d."id" FROM "Department" d JOIN below b ON d."parentId" = b."id"
    )
    SELECT "id" FROM below
  `;
  return rows.map((row) => row.id);
}
