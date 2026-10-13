-- Every person and every pay period belongs to one legal entity (KEHOACH 9.3, 9.6). With a single
-- entity the rows without one are its own; with several, someone has to say which, so this stops.
DO $$
DECLARE
  entities INTEGER;
BEGIN
  IF EXISTS (SELECT 1 FROM "Employee" WHERE "legalEntityId" IS NULL)
     OR EXISTS (SELECT 1 FROM "PayrollPeriod" WHERE "legalEntityId" IS NULL) THEN
    SELECT count(*) INTO entities FROM "LegalEntity";
    IF entities <> 1 THEN
      RAISE EXCEPTION 'rows without a legal entity and % entities: assign each row its entity first', entities;
    END IF;
    UPDATE "Employee" SET "legalEntityId" = (SELECT "id" FROM "LegalEntity") WHERE "legalEntityId" IS NULL;
    UPDATE "PayrollPeriod" SET "legalEntityId" = (SELECT "id" FROM "LegalEntity") WHERE "legalEntityId" IS NULL;
  END IF;
END $$;

-- backfilled by the block above, which stops rather than guess an entity.
ALTER TABLE "Employee" ALTER COLUMN "legalEntityId" SET NOT NULL;

-- backfilled by the block above, which stops rather than guess an entity.
ALTER TABLE "PayrollPeriod" ALTER COLUMN "legalEntityId" SET NOT NULL;
