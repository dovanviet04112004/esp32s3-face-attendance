#!/bin/sh
# Reset one account's two-step sign-in from the VPS, for the last ADMIN who lost both
# phone and backup codes: what the reset button does, trail line included (KEHOACH 9.4 rule 8).
set -eu

if [ "$#" -ne 1 ]; then
    echo "usage: $0 <email>" >&2
    exit 2
fi

# The address reaches psql as a variable and is quoted by it, never spliced into the SQL.
# 'user.mfaReset' is AUDIT_ACTIONS.USER_MFA_RESET in backend/src/modules/audit/audit-actions.ts.
docker exec -i kiosk-postgres sh -c \
    'exec psql --quiet --no-psqlrc -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v email="$1"' \
    sh "$1" <<'SQL'
BEGIN;
CREATE TEMP TABLE target ON COMMIT DROP AS
    SELECT "id" FROM "User" WHERE lower("email") = lower(:'email');
DO $$
BEGIN
    IF (SELECT count(*) FROM target) <> 1 THEN
        RAISE EXCEPTION 'no single account has that address';
    END IF;
END $$;
DELETE FROM "UserMfa" WHERE "userId" = (SELECT "id" FROM target);
UPDATE "Session" SET "revokedAt" = now()
    WHERE "userId" = (SELECT "id" FROM target) AND "revokedAt" IS NULL;
INSERT INTO "AuditLog" ("actorId", "action", "subjectType", "subjectId", "meta")
    SELECT NULL, 'user.mfaReset', 'user', "id", '{"via": "console"}'::jsonb FROM target;
COMMIT;
SQL
echo "two-step sign-in reset for $1; the next sign-in links an authenticator again"
