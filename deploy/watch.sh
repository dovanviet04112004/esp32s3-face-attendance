#!/usr/bin/env bash
#
# Watch everything the fleet says, as the operator role of KEHOACH 7.4.
# A device's own credentials are not borrowed: svc-ops reads kiosk/+/up/#.
#
# Usage:
#   ./watch.sh                 # every up topic of every kiosk
#   ./watch.sh event           # one topic
#   ./watch.sh attendance

set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
set -a; . "${HERE}/.env"; set +a

[[ -n "${EMQX_OPS_PASSWORD:-}" ]] || {
    printf 'no EMQX_OPS_PASSWORD in deploy/.env\n' >&2; exit 1
}

TOPIC="kiosk/+/up/${1:-#}"
printf 'watching %s\n' "${TOPIC}" >&2
exec mosquitto_sub -h 127.0.0.1 -p 8883 \
    --cafile "${HERE}/emqx/certs/ca.crt" --insecure \
    -u svc-ops -P "${EMQX_OPS_PASSWORD}" -i "svc-ops-watch-$$" \
    -t "${TOPIC}" -q 1 -v
