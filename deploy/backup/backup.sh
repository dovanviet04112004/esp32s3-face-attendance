#!/bin/sh
# The nightly run: expire every chain, then two logical dumps and one physical
# base, each encrypted before it touches the disk it is kept on (KEHOACH 4.8).
set -eu
set -o pipefail

: "${PGHOST:?}" "${PGUSER:?}" "${PGDATABASE:?}" "${BACKUP_DIR:?}" "${AGE_RECIPIENT:?}"

stamp=$(date -u +%Y%m%dT%H%M%SZ)
prefix="${BACKUP_DIR}/${PGDATABASE}-${stamp}"
wal="${BACKUP_DIR}/wal"
keep_days="${BACKUP_KEEP_DAYS:-30}"
biometric_keep_days="${BIOMETRIC_KEEP_DAYS:-7}"
wal_wait_s=60
row_keep_days=90

trap 'rm -f "${BACKUP_DIR}"/*.part' EXIT

# Kept N days means gone before the file turns N days old (KEHOACH 9.22.7).
expire() {
    dir="$1"
    days="$2"
    shift 2
    find "${dir}" -maxdepth 1 -type f -mmin "+$((days * 1440 - 60))" "$@" -delete
}

# A file takes its real name only once every stage of its pipe succeeded.
seal() {
    target="$1"
    shift
    "$@" | age --encrypt --recipient "${AGE_RECIPIENT}" --output "${target}.part"
    mv "${target}.part" "${target}"
    echo "$(date -u +%FT%TZ) wrote ${target} $(wc -c < "${target}") bytes"
}

record() {
    psql --quiet --command "INSERT INTO ops.backup_run (kind, bytes) VALUES ('$1', $2)"
}

main_dump() {
    pg_dump --format=custom --compress=6 --exclude-table-data='public."FaceTemplate"'
}

# BiometricConsent stays in the main dump on purpose: it is the evidence that
# an erasure happened, so it outlives what it describes.
biometric_dump() {
    pg_dump --format=custom --compress=6 --table='public."FaceTemplate"'
}

# Fetched WAL makes the base consistent on its own; the archive only carries it forward.
base_tar() {
    pg_basebackup --pgdata=- --format=tar --wal-method=fetch --checkpoint=fast \
        --label="nightly-${stamp}" | zstd --quiet --stdout
}

# Expired first, so a night that fails further down still keeps the biometric
# window; the biometric half goes before the longer glob can ever reach it.
expire "${BACKUP_DIR}" "${biometric_keep_days}" -name "${PGDATABASE}-*.biometric.dump.age"
expire "${BACKUP_DIR}" "${biometric_keep_days}" -name "${PGDATABASE}-*.base.tar.zst.age"
expire "${wal}" "${biometric_keep_days}"
expire "${BACKUP_DIR}" "${keep_days}" -name "${PGDATABASE}-*.dump.age" ! -name '*.biometric.dump.age'

# `ops` is outside what Prisma declares, so migrate diff never asks to drop it.
psql --quiet --command "
    SET client_min_messages = warning;
    CREATE SCHEMA IF NOT EXISTS ops;
    CREATE TABLE IF NOT EXISTS ops.backup_run (
        finished_at timestamptz NOT NULL DEFAULT now(),
        kind        text        NOT NULL,
        bytes       bigint      NOT NULL,
        PRIMARY KEY (finished_at, kind)
    );
    DELETE FROM ops.backup_run WHERE finished_at < now() - interval '${row_keep_days} days';
"

seal "${prefix}.dump.age" main_dump
record dump "$(wc -c < "${prefix}.dump.age")"
seal "${prefix}.biometric.dump.age" biometric_dump
record biometric "$(wc -c < "${prefix}.biometric.dump.age")"

base_started=$(psql --tuples-only --no-align --command "SELECT now()")
seal "${prefix}.base.tar.zst.age" base_tar
record base "$(wc -c < "${prefix}.base.tar.zst.age")"

# pg_basebackup closes a segment as it ends; postgres saying it archived one
# and the file being in wal/ is the nightly end-to-end test (KEHOACH 4.8 rule 5).
waited=0
until archived=$(psql --tuples-only --no-align --command "
          SELECT last_archived_wal FROM pg_stat_archiver
           WHERE last_archived_time > '${base_started}'") \
      && [ -n "${archived}" ] && [ -f "${wal}/${archived}.zst.age" ]; do
    waited=$((waited + 1))
    if [ "${waited}" -gt "${wal_wait_s}" ]; then
        echo "no WAL segment reached ${wal} within ${wal_wait_s} s" >&2
        exit 1
    fi
    sleep 1
done
archived_kib=$(du -sk "${wal}" | cut -f 1)
record wal "$((archived_kib * 1024))"
echo "$(date -u +%FT%TZ) WAL archive live, ${archived_kib} KiB held"
