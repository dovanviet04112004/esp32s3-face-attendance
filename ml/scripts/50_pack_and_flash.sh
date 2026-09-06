#!/usr/bin/env bash
#
# Pack the deployed models into one image and write it to models_0 (KEHOACH 6.2.2).
# Every branch is hashed against contracts/models.lock.json on the way, so a stale
# .tflite under firmware/models/ stops the flash rather than reaching the board.
#
# Usage:
#   ./scripts/50_pack_and_flash.sh                       # pack only
#   ./scripts/50_pack_and_flash.sh --port /dev/ttyACM0   # pack, then write models_0
#   ./scripts/50_pack_and_flash.sh --table ../firmware/partitions.prod.csv

set -uo pipefail

ML_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${ML_ROOT}/.." && pwd)"
PY="${ML_ROOT}/.venv/bin/python"
IMAGE="${REPO_ROOT}/firmware/build/models.bin"
TABLE="${REPO_ROOT}/firmware/partitions.dev.csv"
PARTITION="models_0"
PORT=""

log()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!!\033[0m %s\n' "$*" >&2; }

while [[ $# -gt 0 ]]; do
    case "$1" in
        --port)      PORT="$2"; shift 2 ;;
        --table)     TABLE="$2"; shift 2 ;;
        --partition) PARTITION="$2"; shift 2 ;;
        --out)       IMAGE="$2"; shift 2 ;;
        *) warn "unknown argument $1"; exit 1 ;;
    esac
done

[[ -x "${PY}" ]] || { warn "no venv at ${PY}; run 'uv sync --extra cu130 --extra export' in ml/"; exit 1; }

log "packing ${PARTITION} from contracts/models.lock.json"
"${PY}" -m facepipe.export.pack_models_partition \
    --lock "${REPO_ROOT}/contracts/models.lock.json" \
    --models-dir "${REPO_ROOT}/firmware/models" \
    --partitions "${TABLE}" \
    --partition "${PARTITION}" \
    --out "${IMAGE}" || exit 1

if [[ -z "${PORT}" ]]; then
    log "no --port given, stopping at ${IMAGE}"
    exit 0
fi

[[ -n "${IDF_PATH:-}" ]] || { warn "IDF_PATH is unset; source \$IDF_PATH/export.sh to flash"; exit 1; }

log "writing ${IMAGE} to ${PARTITION} on ${PORT}"
python "${IDF_PATH}/components/partition_table/parttool.py" --port "${PORT}" \
    --partition-table-file "${TABLE}" \
    write_partition --partition-name "${PARTITION}" --input "${IMAGE}"
