#!/bin/sh
# Two dumps, encrypted before either touches the disk it is kept on. The
# biometric half is separate so erasure reaches every copy of it in days
# rather than in whatever the labour-law window happens to be (KEHOACH 9.22.7).
set -eu

: "${PGHOST:?}" "${PGUSER:?}" "${PGDATABASE:?}" "${BACKUP_DIR:?}" "${AGE_RECIPIENT:?}"

stamp=$(date -u +%Y%m%dT%H%M%SZ)
target="${BACKUP_DIR}/${PGDATABASE}-${stamp}.dump.age"
biometric="${BACKUP_DIR}/${PGDATABASE}-${stamp}.biometric.dump.age"
keep_days="${BACKUP_KEEP_DAYS:-30}"
biometric_keep_days="${BIOMETRIC_KEEP_DAYS:-7}"

mkdir -p "${BACKUP_DIR}"

# Piped, never written in the clear: a plain dump on disk between two commands
# is the window somebody copies it in.
pg_dump --format=custom --compress=6 --exclude-table-data='public."FaceTemplate"' \
    | age --encrypt --recipient "${AGE_RECIPIENT}" --output "${target}"

# BiometricConsent stays in the main dump on purpose: it is the evidence that
# an erasure happened, so it outlives what it describes.
pg_dump --format=custom --compress=6 --table='public."FaceTemplate"' \
    | age --encrypt --recipient "${AGE_RECIPIENT}" --output "${biometric}"

size=$(wc -c < "${target}")
biometric_size=$(wc -c < "${biometric}")
echo "$(date -u +%FT%TZ) wrote ${target} ${size} bytes"
echo "$(date -u +%FT%TZ) wrote ${biometric} ${biometric_size} bytes"

# Old enough to be past the retention window, and only ours. The biometric half
# goes first so a stale glob can never sweep it into the longer window.
find "${BACKUP_DIR}" -name "${PGDATABASE}-*.biometric.dump.age" \
    -mtime "+${biometric_keep_days}" -delete
find "${BACKUP_DIR}" -name "${PGDATABASE}-*.dump.age" \
    ! -name '*.biometric.dump.age' -mtime "+${keep_days}" -delete
