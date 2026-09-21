-- The attendance roll-up pages by (fullName, id); without the pair the cursor
-- degrades to a filter and the join falls back to scanning every punch.
CREATE INDEX IF NOT EXISTS "Employee_fullName_id_idx" ON "Employee" ("fullName", "id");
