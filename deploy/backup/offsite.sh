#!/bin/sh
# Every five minutes: copy each sealed backup the ledger has not seen to the
# offsite bucket, never overwriting or deleting there (KEHOACH 4.8 rule 3).
set -eu
set -o pipefail

: "${BACKUP_DIR:?}"
# Unset leaves the offsite chain stale, which the api's watch reports.
[ -n "${OFFSITE_BUCKET:-}" ] || exit 0

export LC_ALL=C
state="${BACKUP_DIR}/.offsite"
ledger="${state}/sent"
held="${state}/held"
mkdir -p "${state}"
touch "${ledger}"

exec 9> "${state}/lock"
flock -n 9 || exit 0

# The bucket's lifecycle rules key on these prefixes, one per retention.
chain_of() {
    case "$1" in
        wal/*.zst.age) echo wal ;;
        *.biometric.dump.age) echo biometric ;;
        *.base.tar.zst.age) echo base ;;
        *.dump.age) echo dump ;;
        *) return 1 ;;
    esac
}

# Never overwrites; an object already there counts as sent only when its md5 matches.
send() {
    want=$(md5sum < "$1" | cut -d ' ' -f 1)
    rclone copyto --ignore-existing --quiet --retries 1 --low-level-retries 3 "$1" "$2" || return 1
    [ "$(rclone md5sum --quiet "$2" | cut -d ' ' -f 1)" = "${want}" ] && return 0
    echo "$2 differs from $1; left untouched" >&2
    return 1
}

cd "${BACKUP_DIR}"
find . -path ./.offsite -prune -o -type f -name '*.age' -print | sed 's|^\./||' | sort > "${held}"

sent=0
sent_bytes=0
failed=0
for name in $(comm -23 "${held}" "${ledger}"); do
    chain=$(chain_of "${name}") || continue
    if send "${name}" "offsite:${OFFSITE_BUCKET}/${chain}/${name##*/}"; then
        echo "${name}" >> "${ledger}"
        sent=$((sent + 1))
        sent_bytes=$((sent_bytes + $(wc -c < "${name}")))
    else
        failed=$((failed + 1))
    fi
done

# Names expired here leave the ledger, so it never outgrows the volume's own listing.
sort -u "${ledger}" | comm -12 - "${held}" > "${ledger}.part"
mv "${ledger}.part" "${ledger}"

if [ "${failed}" -gt 0 ]; then
    echo "$(date -u +%FT%TZ) offsite: ${failed} file(s) not copied, ${sent} copied" >&2
    exit 1
fi
[ "${sent}" -gt 0 ] || exit 0
psql --quiet --command "INSERT INTO ops.backup_run (kind, bytes) VALUES ('offsite', ${sent_bytes})"
echo "$(date -u +%FT%TZ) offsite: copied ${sent} file(s), ${sent_bytes} bytes"
