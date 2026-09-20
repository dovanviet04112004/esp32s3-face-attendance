#!/bin/sh
# One full dump, encrypted before it touches the disk it is kept on.
set -eu

: "${PGHOST:?}" "${PGUSER:?}" "${PGDATABASE:?}" "${BACKUP_DIR:?}" "${AGE_RECIPIENT:?}"

stamp=$(date -u +%Y%m%dT%H%M%SZ)
target="${BACKUP_DIR}/${PGDATABASE}-${stamp}.dump.age"
keep_days="${BACKUP_KEEP_DAYS:-30}"

mkdir -p "${BACKUP_DIR}"

# Piped, never written in the clear: a plain dump on disk between two commands
# is the window somebody copies it in.
pg_dump --format=custom --compress=6 \
    | age --encrypt --recipient "${AGE_RECIPIENT}" --output "${target}"

size=$(wc -c < "${target}")
echo "$(date -u +%FT%TZ) wrote ${target} ${size} bytes"

# Old enough to be past the retention window, and only ours.
find "${BACKUP_DIR}" -name "${PGDATABASE}-*.dump.age" -mtime "+${keep_days}" -delete
