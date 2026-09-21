#!/bin/sh
# Rebuild the newest backup into a database nobody uses, count what came back,
# and time it. A backup never restored is not a backup (KEHOACH 9.22.2).
set -eu

: "${PGHOST:?}" "${PGUSER:?}" "${PGDATABASE:?}" "${BACKUP_DIR:?}" "${AGE_KEY_FILE:?}"

newest=$(ls -1t "${BACKUP_DIR}"/${PGDATABASE}-*.dump.age 2>/dev/null \
    | grep -v '\.biometric\.dump\.age$' | head -1)
if [ -z "${newest}" ]; then
    echo "no backup to drill" >&2
    exit 1
fi

drill="${PGDATABASE}_drill"
started=$(date +%s)

psql --dbname postgres -c "DROP DATABASE IF EXISTS \"${drill}\""
psql --dbname postgres -c "CREATE DATABASE \"${drill}\""

age --decrypt --identity "${AGE_KEY_FILE}" "${newest}" \
    | pg_restore --dbname "${drill}" --no-owner --no-privileges --exit-on-error

finished=$(date +%s)
took=$((finished - started))

echo "$(date -u +%FT%TZ) restored ${newest} into ${drill} in ${took}s"

# Counted, not estimated: pg_stat_user_tables holds what ANALYZE last saw, and
# a database restored a second ago has never been analysed, so its biggest
# tables read as empty.
counts="SELECT relname, (xpath('/row/n/text()', census))[1]::text::bigint AS rows
          FROM (SELECT relname,
                       query_to_xml(format('SELECT count(*) AS n FROM %I.%I', schemaname, relname),
                                    false, true, '') AS census
                  FROM pg_stat_user_tables) counted
         ORDER BY rows DESC"

echo "rows per table:"
psql --dbname "${drill}" --tuples-only --no-align --field-separator="=" --command "${counts}"

empty=$(psql --dbname "${drill}" --tuples-only --no-align --command \
    "SELECT count(*) FROM (${counts}) t WHERE rows = 0")
total=$(psql --dbname "${drill}" --tuples-only --no-align --command \
    "SELECT coalesce(sum(rows), 0) FROM (${counts}) t")
echo "tables that came back empty: ${empty}"
echo "rows restored in total: ${total}"

# A rule nobody checks is a comment. Whoever drops the exclude flag finds out
# here rather than on the day somebody asks to be erased (KEHOACH 9.22.7).
templates=$(psql --dbname "${drill}" --tuples-only --no-align --command \
    'SELECT count(*) FROM "FaceTemplate"')
if [ "${templates}" != "0" ]; then
    echo "the main dump carries ${templates} face template(s); it must carry none" >&2
    psql --dbname postgres -c "DROP DATABASE \"${drill}\""
    exit 1
fi
echo "face templates in the main dump: 0"

psql --dbname postgres -c "DROP DATABASE \"${drill}\""
echo "drill finished in ${took}s"
