-- ILIKE '%x%' cannot use a B-tree index, so finding a person scans the table.
-- Trigram GIN indexes do support it, and finding a person is what HR does most
-- in a day (KEHOACH 9.9 rule 4).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS "Employee_fullName_trgm_idx"
    ON "Employee" USING gin ("fullName" gin_trgm_ops);

CREATE INDEX IF NOT EXISTS "Employee_code_trgm_idx"
    ON "Employee" USING gin ("code" gin_trgm_ops);
