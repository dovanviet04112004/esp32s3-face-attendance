-- Two company-wide holidays on one date both passed the unique index, because
-- Postgres treats NULL legalEntityId values as distinct from each other.
DELETE FROM "Holiday" a
      USING "Holiday" b
      WHERE a."date" = b."date"
        AND a."legalEntityId" IS NOT DISTINCT FROM b."legalEntityId"
        AND a."createdAt" > b."createdAt";

DROP INDEX IF EXISTS "Holiday_legalEntityId_date_key";

CREATE UNIQUE INDEX "Holiday_legalEntityId_date_key"
    ON "Holiday" ("legalEntityId", "date") NULLS NOT DISTINCT;
