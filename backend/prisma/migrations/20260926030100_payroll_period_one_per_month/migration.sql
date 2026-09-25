-- Two company-wide periods for one month both passed the unique index, because
-- Postgres treats NULL legalEntityId values as distinct from each other. An
-- empty duplicate goes; one that holds runs or back pay stays and stops the index.
DELETE FROM "PayrollPeriod" a
      USING "PayrollPeriod" b
      WHERE a."year" = b."year"
        AND a."month" = b."month"
        AND a."legalEntityId" IS NOT DISTINCT FROM b."legalEntityId"
        AND a."createdAt" > b."createdAt"
        AND NOT EXISTS (SELECT 1 FROM "PayrollRun" r WHERE r."periodId" = a."id")
        AND NOT EXISTS (
          SELECT 1 FROM "RetroAdjustment" x
           WHERE x."sourcePeriodId" = a."id" OR x."appliedPeriodId" = a."id"
        );

DROP INDEX IF EXISTS "PayrollPeriod_legalEntityId_year_month_key";

CREATE UNIQUE INDEX "PayrollPeriod_legalEntityId_year_month_key"
    ON "PayrollPeriod" ("legalEntityId", "year", "month") NULLS NOT DISTINCT;
