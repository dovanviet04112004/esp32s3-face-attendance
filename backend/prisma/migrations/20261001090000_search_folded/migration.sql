-- Matching runs on folded text so "nguyen" finds "Nguyễn" (KEHOACH 9.9 rule 4).
-- unaccent is STABLE and cannot sit in an index; this wrapper names its dictionary and is IMMUTABLE.
CREATE EXTENSION IF NOT EXISTS unaccent;

CREATE OR REPLACE FUNCTION f_unaccent(text) RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
    AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, $1) $$;

CREATE INDEX IF NOT EXISTS "Employee_fullName_folded_trgm_idx"
    ON "Employee" USING gin (f_unaccent(lower("fullName")) gin_trgm_ops);

DROP INDEX IF EXISTS "Employee_fullName_trgm_idx";
