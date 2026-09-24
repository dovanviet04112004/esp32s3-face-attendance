#!/usr/bin/env bash
# Rebuild the newest backups on the machine holding the age key: replay the
# physical base and its WAL, then restore the logical dump (KEHOACH 9.22.2).
set -euo pipefail
# Segment names compare as bytes, whatever the caller's locale collates.
export LC_ALL=C

host="${1:?usage: AGE_KEY_FILE=<private key> restore-drill.sh <ssh host>}"
: "${AGE_KEY_FILE:?path to the age private key}"
[[ -r "${AGE_KEY_FILE}" ]] || { echo "cannot read ${AGE_KEY_FILE}" >&2; exit 1; }
docker="${DOCKER:-docker}"
replay_box=kiosk-drill-replay
dump_box=kiosk-drill
drill=drill
pgdata=/var/lib/postgresql/data
poll_s=5
settled_polls=3
max_polls=180

cleanup() {
    "${docker}" rm -f "${replay_box}" "${dump_box}" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# The script goes in on stdin, so nothing in it passes through two shells' quoting.
remote() {
    printf '%s\n' "$1" | ssh "${host}" docker exec -i kiosk-backup sh
}

fetch() {
    ssh "${host}" docker exec kiosk-backup cat "$1"
}

# A throwaway postgres with age and the key in a tmpfs, never on its disk.
# Arguments before -- go to docker run, the ones after it to the image.
scratch() {
    local box="$1" options=()
    shift
    while (( $# > 0 )) && [[ "$1" != "--" ]]; do
        options+=("$1")
        shift
    done
    (( $# == 0 )) || shift
    "${docker}" run -d --rm --name "${box}" --tmpfs /keys:mode=0700 "${options[@]}" postgres:16-alpine "$@" >/dev/null
    "${docker}" exec "${box}" apk add --no-cache --quiet age
    "${docker}" exec -i "${box}" sh -c 'cat > /keys/age.key' < "${AGE_KEY_FILE}"
}

wait_ready() {
    local box="$1" tries=0
    shift
    until "${docker}" exec "${box}" pg_isready --quiet "$@"; do
        tries=$((tries + 1))
        if (( tries > 60 )); then
            echo "${box}: postgres never came up" >&2
            "${docker}" exec "${box}" sh -c 'tail -n 20 /tmp/postgres.log 2>/dev/null' >&2 || true
            exit 1
        fi
        sleep 1
    done
}

# Counted, not estimated: a database restored a second ago has never been analysed.
counts="SELECT relname, (xpath('/row/n/text()', census))[1]::text::bigint AS rows
          FROM (SELECT relname,
                       query_to_xml(format('SELECT count(*) AS n FROM %I.%I', schemaname, relname),
                                    false, true, '') AS census
                  FROM pg_stat_user_tables) counted
         ORDER BY rows DESC"

db=$(remote 'echo "${PGDATABASE}"')
owner=$(remote 'echo "${PGUSER}"')
base=$(remote 'ls -1t "${BACKUP_DIR}/${PGDATABASE}"-*.base.tar.zst.age 2>/dev/null | head -n 1')
dump=$(remote 'ls -1t "${BACKUP_DIR}/${PGDATABASE}"-*.dump.age | grep -v "\.biometric\.dump\.age$" | head -n 1')
[[ -n "${base}" ]] || { echo "no base backup to replay" >&2; exit 1; }
[[ -n "${dump}" ]] || { echo "no logical dump to restore" >&2; exit 1; }

echo "== replay: ${base}"
started=$(date +%s)
scratch "${replay_box}" --entrypoint sleep -e PGDATA="${pgdata}" -- infinity
fetch "${base}" | "${docker}" exec -i "${replay_box}" sh -c \
    "set -o pipefail; age --decrypt --identity /keys/age.key | zstd -dc | tar -xf - -C ${pgdata}"

start=$("${docker}" exec "${replay_box}" sed -n 's/^START WAL LOCATION: .*(file \([0-9A-F]*\))$/\1/p' "${pgdata}/backup_label")
timeline=$("${docker}" exec "${replay_box}" sed -n 's/^START TIMELINE: //p' "${pgdata}/backup_label")
[[ "${start}" =~ ^[0-9A-F]{24}$ ]] || { echo "backup_label names no start segment" >&2; exit 1; }

# Only segments at or after the base's own start can ever be asked for.
remote "cd \"\${BACKUP_DIR}/wal\" && ls | grep -E '^[0-9A-F]{24}\\.zst\\.age\$' \
    | awk -v start=${start} '(substr(\$0, 1, 24) \"\") >= (start \"\")' | tar -cf - -T -" \
    | "${docker}" exec -i "${replay_box}" sh -c 'mkdir -p /wal && tar -xf - -C /wal'
newest=$("${docker}" exec "${replay_box}" sh -c 'ls /wal | sort | tail -n 1 | cut -c 1-24')
segments=$("${docker}" exec "${replay_box}" sh -c 'ls /wal | wc -l')
echo "fetched ${segments} WAL segment(s) from ${start} to ${newest:-none}"

# restore_command runs as postgres, so the key and the segments are handed to it.
"${docker}" exec "${replay_box}" sh -c "chown -R postgres:postgres ${pgdata} /wal /keys && chmod 0700 ${pgdata} && touch ${pgdata}/standby.signal"
restore='set -o pipefail; f=/wal/%f.zst.age; [ -f "$f" ] && age --decrypt --identity /keys/age.key "$f" | zstd -dc > "%p"'
"${docker}" exec -d -u postgres "${replay_box}" sh -c \
    "postgres -D ${pgdata} -c listen_addresses= -c archive_mode=off -c hot_standby=on -c 'restore_command=${restore}' > /tmp/postgres.log 2>&1"
wait_ready "${replay_box}" --username "${owner}" --dbname "${db}"

replayed() {
    "${docker}" exec "${replay_box}" psql --username "${owner}" --dbname "${db}" \
        --tuples-only --no-align --command 'SELECT pg_last_wal_replay_lsn()'
}

# Standby mode keeps asking the archive, so settled means the same position for 15 s.
last="" same=0 polls=0
while (( same < settled_polls )); do
    now_at=$(replayed)
    if [[ "${now_at}" == "${last}" ]]; then same=$((same + 1)); else same=0; last="${now_at}"; fi
    polls=$((polls + 1))
    (( polls <= max_polls )) || { echo "replay never settled, last at ${last}" >&2; exit 1; }
    sleep "${poll_s}"
done
took=$(( $(date +%s) - started - settled_polls * poll_s ))

high=${last%/*}
low=${last#*/}
reached=$(printf '%08X%08X%08X' "$((10#${timeline}))" "$((16#${high}))" "$(( 16#${low} >> 24 ))")
last_xact=$("${docker}" exec "${replay_box}" psql --username "${owner}" --dbname "${db}" \
    --tuples-only --no-align --command 'SELECT pg_last_xact_replay_timestamp()')

echo "replayed to ${last} (segment ${reached}) in ${took}s"
echo "last transaction replayed: ${last_xact:-none}"
echo "rows per table after replay:"
"${docker}" exec "${replay_box}" psql --username "${owner}" --dbname "${db}" \
    --tuples-only --no-align --field-separator="=" --command "${counts}"
if [[ -n "${newest}" && "${reached}" < "${newest}" ]]; then
    echo "replay stopped at ${reached} but the archive runs to ${newest}: the chain has a gap" >&2
    "${docker}" exec "${replay_box}" tail -n 20 /tmp/postgres.log >&2
    exit 1
fi
"${docker}" rm -f "${replay_box}" >/dev/null

echo "== logical: ${dump}"
scratch "${dump_box}" -e POSTGRES_USER="${drill}" -e POSTGRES_PASSWORD="${drill}" -e POSTGRES_DB="${drill}"
# The entrypoint's first server listens on the socket only, then restarts.
wait_ready "${dump_box}" --host 127.0.0.1 --username "${drill}"

sql() {
    "${docker}" exec "${dump_box}" psql --username "${drill}" --dbname "${drill}" "$@"
}

started=$(date +%s)
fetch "${dump}" | "${docker}" exec -i "${dump_box}" sh -c \
    "set -o pipefail; age --decrypt --identity /keys/age.key | pg_restore --username ${drill} --dbname ${drill} --no-owner --no-privileges --exit-on-error"
took=$(( $(date +%s) - started ))
echo "$(date -u +%FT%TZ) restored ${dump} in ${took}s"

echo "rows per table:"
sql --tuples-only --no-align --field-separator="=" --command "${counts}"
empty=$(sql --tuples-only --no-align --command "SELECT count(*) FROM (${counts}) t WHERE rows = 0")
total=$(sql --tuples-only --no-align --command "SELECT coalesce(sum(rows), 0) FROM (${counts}) t")
echo "tables that came back empty: ${empty}"
echo "rows restored in total: ${total}"

# Whoever drops the exclude flag finds out here, not on an erasure request (KEHOACH 9.22.7).
templates=$(sql --tuples-only --no-align --command 'SELECT count(*) FROM "FaceTemplate"')
if [[ "${templates}" != "0" ]]; then
    echo "the main dump carries ${templates} face template(s); it must carry none" >&2
    exit 1
fi
echo "face templates in the main dump: 0"
echo "drill finished"
