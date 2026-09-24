#!/bin/sh
# Called by postgres archive_command, once per finished WAL segment. Exit 0
# tells postgres the segment is safe to recycle (KEHOACH 4.8).
set -eu
set -o pipefail

: "${BACKUP_DIR:?}" "${AGE_RECIPIENT:?}"

source_path="$1"
name="$2"
dir="${BACKUP_DIR}/wal"
target="${dir}/${name}.zst.age"
stamp="${dir}/${name}.sha256"

[ -d "${dir}" ] || { echo "${dir} is missing; pg-start.sh makes it" >&2; exit 1; }

digest=$(sha256sum < "${source_path}" | cut -d ' ' -f 1)

# A segment pushed just before a crash comes back: the same bytes are success,
# other bytes mean two clusters write into one archive.
if [ -f "${target}" ]; then
    [ "$(cat "${stamp}" 2>/dev/null)" = "${digest}" ] && exit 0
    echo "refusing to overwrite ${target} with different content" >&2
    exit 1
fi

# Compressed first: an encrypted segment no longer compresses.
zstd --quiet --stdout < "${source_path}" \
    | age --encrypt --recipient "${AGE_RECIPIENT}" --output "${target}.part"
printf '%s\n' "${digest}" > "${stamp}.part"
sync "${target}.part" "${stamp}.part"

# The stamp lands first, so a segment that exists always has one to compare.
mv "${stamp}.part" "${stamp}"
mv "${target}.part" "${target}"
sync "${dir}"
