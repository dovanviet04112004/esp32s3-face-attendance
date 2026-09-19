-- Codes minted before the sequential scheme came from a slug of the name, which
-- strips Vietnamese diacritics: "Kỹ thuật" became "K-THU-T", and two names that
-- differ only in tone flatten to the same code. Renumber whatever does not
-- already follow the scheme, per legal entity (KEHOACH 9.3).
WITH renumbered AS (
    SELECT "id",
           'PB' || lpad(
               (row_number() OVER (PARTITION BY "legalEntityId" ORDER BY "createdAt", "name"))::text,
               4, '0') AS next_code
    FROM "Department"
    WHERE "code" !~ '^PB[0-9]{4}$'
)
UPDATE "Department" d
SET "code" = r.next_code
FROM renumbered r
WHERE d."id" = r."id";
