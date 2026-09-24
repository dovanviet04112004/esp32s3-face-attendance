#!/bin/sh
# Rebuild the newest backup on the machine holding the age key, count what came
# back, and time it. The VPS keeps only the public half (KEHOACH 9.22.2).
set -eu

host="${1:?usage: AGE_KEY_FILE=<private key> restore-drill.sh <ssh host>}"
: "${AGE_KEY_FILE:?path to the age private key}"
[ -r "${AGE_KEY_FILE}" ] || { echo "cannot read ${AGE_KEY_FILE}" >&2; exit 1; }
docker="${DOCKER:-docker}"
box=kiosk-drill
drill=drill

work=$(mktemp -d)
cleanup() {
    "${docker}" rm -f "${box}" >/dev/null 2>&1 || true
    rm -rf "${work}"
}
trap cleanup EXIT

newest=$(ssh "${host}" 'docker exec kiosk-backup sh -c '\''ls -1t "$BACKUP_DIR/$PGDATABASE"-*.dump.age | grep -v "\.biometric\.dump\.age$" | head -1'\''')
if [ -z "${newest}" ]; then
    echo "no backup to drill" >&2
    exit 1
fi
ssh "${host}" docker exec kiosk-backup cat "${newest}" > "${work}/newest.dump.age"
echo "fetched ${newest} ($(wc -c < "${work}/newest.dump.age") bytes)"

"${docker}" run -d --rm --name "${box}" --tmpfs /keys:mode=0700 \
    -e POSTGRES_USER="${drill}" -e POSTGRES_PASSWORD="${drill}" -e POSTGRES_DB="${drill}" \
    postgres:16-alpine >/dev/null
"${docker}" exec "${box}" apk add --no-cache --quiet age
"${docker}" exec -i "${box}" sh -c 'cat > /keys/age.key' < "${AGE_KEY_FILE}"

# The entrypoint's first server listens on the socket only, then restarts.
waited=0
until "${docker}" exec "${box}" pg_isready --quiet --host 127.0.0.1 --username "${drill}"; do
    waited=$((waited + 1))
    [ "${waited}" -lt 60 ] || { echo "scratch postgres never came up" >&2; exit 1; }
    sleep 1
done

sql() {
    "${docker}" exec "${box}" psql --username "${drill}" --dbname "${drill}" "$@"
}

started=$(date +%s)
"${docker}" exec -i "${box}" sh -c \
    "age --decrypt --identity /keys/age.key | pg_restore --username ${drill} --dbname ${drill} --no-owner --no-privileges --exit-on-error" \
    < "${work}/newest.dump.age"
took=$(( $(date +%s) - started ))

echo "$(date -u +%FT%TZ) restored ${newest} in ${took}s"

# Counted, not estimated: a database restored a second ago has never been analysed.
counts="SELECT relname, (xpath('/row/n/text()', census))[1]::text::bigint AS rows
          FROM (SELECT relname,
                       query_to_xml(format('SELECT count(*) AS n FROM %I.%I', schemaname, relname),
                                    false, true, '') AS census
                  FROM pg_stat_user_tables) counted
         ORDER BY rows DESC"

echo "rows per table:"
sql --tuples-only --no-align --field-separator="=" --command "${counts}"

empty=$(sql --tuples-only --no-align --command "SELECT count(*) FROM (${counts}) t WHERE rows = 0")
total=$(sql --tuples-only --no-align --command "SELECT coalesce(sum(rows), 0) FROM (${counts}) t")
echo "tables that came back empty: ${empty}"
echo "rows restored in total: ${total}"

# Whoever drops the exclude flag finds out here, not on an erasure request (KEHOACH 9.22.7).
templates=$(sql --tuples-only --no-align --command 'SELECT count(*) FROM "FaceTemplate"')
if [ "${templates}" != "0" ]; then
    echo "the main dump carries ${templates} face template(s); it must carry none" >&2
    exit 1
fi
echo "face templates in the main dump: 0"
echo "drill finished in ${took}s"
