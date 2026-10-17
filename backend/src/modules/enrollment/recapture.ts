import type { PrismaClient } from "@prisma/client";

type Reader = Pick<PrismaClient, "$queryRaw">;

export interface RecaptureDue {
  employeeId: number;
  deviceId: string;
  model: string;
}

/** The kiosks, approved and holding the pair, that run a model newer than every face a person holds; the model
 *  of their last capture counts as held after its set is swept. Newest model first per person (KEHOACH 9.21.4).
 *  @ctx any | one read; null reads everybody
 */
export function recaptureDue(db: Reader, employeeIds: readonly number[] | null): Promise<RecaptureDue[]> {
  const only = employeeIds === null ? null : [...employeeIds];
  return db.$queryRaw<RecaptureDue[]>`
    WITH released AS (
      SELECT "embeddingVersion" AS "model", min("createdAt") AS "at"
        FROM "Release"
       WHERE "target" = 'MODELS' AND "embeddingVersion" IS NOT NULL
       GROUP BY 1
    ), doors AS (
      SELECT de."employeeId", d."id" AS "deviceId", d."embeddingVersion" AS "model", r."at"
        FROM "DeviceEnrollment" de
        JOIN "Device" d ON d."id" = de."deviceId"
        JOIN released r ON r."model" = d."embeddingVersion"
       WHERE d."status" = 'APPROVED' AND de."state" <> 'REVOKED'
         AND (${only}::int[] IS NULL OR de."employeeId" = ANY(${only}::int[]))
    ), held AS (
      SELECT t."employeeId", t."embeddingVersion" AS "model"
        FROM "FaceTemplate" t
       WHERE t."embeddingVersion" IS NOT NULL AND t."employeeId" IN (SELECT "employeeId" FROM doors)
      UNION
      SELECT e."id", e."embeddingVersion"
        FROM "Employee" e
       WHERE e."embeddingVersion" IS NOT NULL AND e."id" IN (SELECT "employeeId" FROM doors)
    ), newest AS (
      SELECT h."employeeId", max(COALESCE(r."at", '-infinity'::timestamp)) AS "at"
        FROM held h
        LEFT JOIN released r ON r."model" = h."model"
       GROUP BY 1
    )
    SELECT doors."employeeId", doors."deviceId", doors."model"
      FROM doors
      JOIN newest n ON n."employeeId" = doors."employeeId"
     WHERE doors."at" > n."at"
     ORDER BY doors."employeeId", doors."at" DESC, doors."deviceId"
  `;
}

/** Whether a person holds a set on this model or on one that reached the server after it (KEHOACH 9.21.4). */
export async function holdsAtLeast(db: Reader, employeeId: number, model: string): Promise<boolean> {
  const [found] = await db.$queryRaw<{ holds: boolean }[]>`
    WITH released AS (
      SELECT "embeddingVersion" AS "model", min("createdAt") AS "at"
        FROM "Release"
       WHERE "target" = 'MODELS' AND "embeddingVersion" IS NOT NULL
       GROUP BY 1
    )
    SELECT EXISTS (
      SELECT 1
        FROM "FaceTemplate" t
        LEFT JOIN released mine ON mine."model" = t."embeddingVersion"
        LEFT JOIN released wanted ON wanted."model" = ${model}
       WHERE t."employeeId" = ${employeeId}
         AND (t."embeddingVersion" = ${model} OR mine."at" >= COALESCE(wanted."at", '-infinity'::timestamp))
    ) AS "holds"
  `;
  return found?.holds ?? false;
}
