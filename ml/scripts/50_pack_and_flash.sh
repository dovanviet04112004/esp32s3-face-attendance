#!/usr/bin/env bash
#
# Pack the deployed models into one image and write it to both models_0 and models_1
# (KEHOACH 6.2.2), since the kiosk reads whichever one model/active_slot names.
# Every branch is hashed against contracts/models.lock.json on the way, so a stale
# .tflite under firmware/models/ stops the flash rather than reaching the board.
#
# Usage:
#   ./scripts/50_pack_and_flash.sh                       # pack only
#   ./scripts/50_pack_and_flash.sh --port /dev/ttyACM0   # pack, then write both slots
#   ./scripts/50_pack_and_flash.sh --table ../firmware/partitions.prod.csv
#   ./scripts/50_pack_and_flash.sh --lock <dir>/models.lock.json --models-dir <dir>   # a set under test

set -uo pipefail

ML_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "${ML_ROOT}/.." && pwd)"
PY="${ML_ROOT}/.venv/bin/python"
IMAGE="${REPO_ROOT}/firmware/build/models.bin"
TABLE="${REPO_ROOT}/firmware/partitions.dev.csv"
SLOTS=(models_0 models_1)
PORT=""
LOCK="${REPO_ROOT}/contracts/models.lock.json"
MODELS_DIR="${REPO_ROOT}/firmware/models"

log()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!!\033[0m %s\n' "$*" >&2; }

while [[ $# -gt 0 ]]; do
    case "$1" in
        --port)      PORT="$2"; shift 2 ;;
        --table)     TABLE="$2"; shift 2 ;;
        --out)       IMAGE="$2"; shift 2 ;;
        --lock)       LOCK="$2"; shift 2 ;;
        --models-dir) MODELS_DIR="$2"; shift 2 ;;
        *) warn "unknown argument $1"; exit 1 ;;
    esac
done

[[ -x "${PY}" ]] || { warn "no venv at ${PY}; run 'uv sync --extra cu130 --extra export' in ml/"; exit 1; }

log "packing ${SLOTS[*]} from ${LOCK}"
"${PY}" -m facepipe.export.pack_models_partition \
    --lock "${LOCK}" \
    --models-dir "${MODELS_DIR}" \
    --partitions "${TABLE}" \
    --partition "${SLOTS[0]}" \
    --out "${IMAGE}" || exit 1

if [[ -z "${PORT}" ]]; then
    log "no --port given, stopping at ${IMAGE}"
    exit 0
fi

[[ -n "${IDF_PATH:-}" ]] || { warn "IDF_PATH is unset; source \$IDF_PATH/export.sh to flash"; exit 1; }

for slot in "${SLOTS[@]}"; do
    log "writing ${IMAGE} to ${slot} on ${PORT}"
    python "${IDF_PATH}/components/partition_table/parttool.py" --port "${PORT}" \
        --partition-table-file "${TABLE}" \
        write_partition --partition-name "${slot}" --input "${IMAGE}" || exit 1
done
