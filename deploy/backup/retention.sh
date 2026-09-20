#!/bin/sh
# Drop whole partitions rather than deleting rows: a DELETE of a million rows
# writes a million dead tuples and then asks vacuum to clean them, while a
# DROP is one catalogue change (KEHOACH 9.22.7).
set -eu

: "${PGHOST:?}" "${PGUSER:?}" "${PGDATABASE:?}"

keep_months="${ATTENDANCE_KEEP_MONTHS:-84}"
ahead_months="${PARTITION_AHEAD_MONTHS:-6}"
apply="${RETENTION_APPLY:-no}"

# Months that fall entirely outside the window. Named by the suffix the
# partition carries, so the shape of the name is the only coupling.
cutoff=$(psql --tuples-only --no-align --command \
    "SELECT to_char(date_trunc('month', CURRENT_DATE) - INTERVAL '${keep_months} months', 'YYYYMM')")

expired=$(psql --tuples-only --no-align --command "
    SELECT c.relname
      FROM pg_class c
      JOIN pg_inherits i ON i.inhrelid = c.oid
     WHERE i.inhparent = '\"AttendanceDay\"'::regclass
       AND right(c.relname, 6) < '${cutoff}'
     ORDER BY c.relname")

if [ -z "${expired}" ]; then
    echo "$(date -u +%FT%TZ) nothing past ${keep_months} months, cutoff ${cutoff}"
else
    for one in ${expired}; do
        rows=$(psql --tuples-only --no-align --command "SELECT count(*) FROM \"${one}\"")
        if [ "${apply}" = "yes" ]; then
            psql --command "DROP TABLE \"${one}\""
            echo "$(date -u +%FT%TZ) dropped ${one}, ${rows} rows"
        else
            echo "$(date -u +%FT%TZ) would drop ${one}, ${rows} rows (set RETENTION_APPLY=yes)"
        fi
    done
fi

# A write with no partition to land in fails, so the months ahead are made
# before anybody needs them.
psql --quiet --command "
DO \$\$
DECLARE
    at   DATE := date_trunc('month', CURRENT_DATE)::date;
    stop DATE := (date_trunc('month', CURRENT_DATE) + INTERVAL '${ahead_months} months')::date;
    name TEXT;
BEGIN
    WHILE at <= stop LOOP
        name := 'AttendanceDay_' || to_char(at, 'YYYYMM');
        IF to_regclass(format('%I', name)) IS NULL THEN
            EXECUTE format(
                'CREATE TABLE %I PARTITION OF \"AttendanceDay\" FOR VALUES FROM (%L) TO (%L)',
                name, at, at + INTERVAL '1 month');
            RAISE NOTICE 'created %', name;
        END IF;
        at := (at + INTERVAL '1 month')::date;
    END LOOP;
END \$\$;"
