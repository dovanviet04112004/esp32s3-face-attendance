-- Codes are ASCII and match with ILIKE beside the folded name; without this the OR scans the table (KEHOACH 9.9 rule 4).
CREATE INDEX IF NOT EXISTS "Employee_code_trgm_idx"
    ON "Employee" USING gin ("code" gin_trgm_ops);
