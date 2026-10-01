-- The search box matches a request's reason folded; without this every term scans "Request" (KEHOACH 9.9 rule 4).
CREATE INDEX IF NOT EXISTS "Request_reason_folded_trgm_idx"
    ON "Request" USING gin (f_unaccent(lower("reason")) gin_trgm_ops);
