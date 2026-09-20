#!/bin/sh
# Called by postgres archive_command, once per finished WAL segment. It must
# refuse to overwrite: postgres treats success as "this segment is safe".
set -eu

: "${BACKUP_DIR:?}" "${AGE_RECIPIENT:?}"

source_path="$1"
name="$2"
target="${BACKUP_DIR}/wal/${name}.age"

mkdir -p "${BACKUP_DIR}/wal"

if [ -f "${target}" ]; then
    echo "refusing to overwrite ${target}" >&2
    exit 1
fi

age --encrypt --recipient "${AGE_RECIPIENT}" --output "${target}.part" < "${source_path}"
mv "${target}.part" "${target}"
