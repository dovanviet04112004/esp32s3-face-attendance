-- Two company-wide policies on one date both passed the unique index, and the
-- lookup then picked either. A duplicate no payslip was priced by goes, the
-- older first; one that priced payslips stays and stops the index.
DELETE FROM "PayrollPolicy" a
      USING "PayrollPolicy" b
      WHERE a."effectiveFrom" = b."effectiveFrom"
        AND a."legalEntityId" IS NOT DISTINCT FROM b."legalEntityId"
        AND a."createdAt" < b."createdAt"
        AND NOT EXISTS (SELECT 1 FROM "Payslip" p WHERE p."policyId" = a."id");

DROP INDEX IF EXISTS "PayrollPolicy_legalEntityId_effectiveFrom_key";

CREATE UNIQUE INDEX "PayrollPolicy_legalEntityId_effectiveFrom_key"
    ON "PayrollPolicy" ("legalEntityId", "effectiveFrom") NULLS NOT DISTINCT;
