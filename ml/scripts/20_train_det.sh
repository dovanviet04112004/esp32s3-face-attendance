#!/usr/bin/env bash
#
# Train the detection branch. Restarts itself from its own last.pth when the
# run dies, with a ceiling on attempts so a real fault cannot loop forever.
#
# Usage:
#   ./scripts/20_train_det.sh
#   ./scripts/20_train_det.sh configs/detection/yunet.yaml train.epochs=50
#   ./scripts/20_train_det.sh configs/detection/yunet.yaml \
#       train.resume=artifacts/detection/runs/<run>/ckpt/last.pth
#
# Resuming needs the checkpoint path spelled out: a fresh invocation looks for
# runs newer than its own start time, so it never finds an earlier session's.

set -uo pipefail

ML_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="${ML_ROOT}/.venv/bin/python"
MODULE="facepipe.tasks.detection.train"
RUNS="${ML_ROOT}/artifacts/detection/runs"
CFG="${1:-configs/detection/yunet.yaml}"
[[ $# -gt 0 ]] && shift
OVERRIDES=("$@")

log()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!!\033[0m %s\n' "$*" >&2; }

# shellcheck source=_resume_loop.sh
source "${ML_ROOT}/scripts/_resume_loop.sh"

[[ -x "${PY}" ]] || { warn "no venv at ${PY}; run 'uv sync' in ml/"; exit 1; }

launch() {
    local run="$1" resume=()
    if [[ -n "${run}" && -f "${run}ckpt/last.pth" ]]; then
        resume=("train.resume=${run}ckpt/last.pth")
        log "resuming from ${run}ckpt/last.pth"
    fi
    cd "${ML_ROOT}" || return 1
    "${PY}" -m "${MODULE}" --cfg "${CFG}" --set "${OVERRIDES[@]}" "${resume[@]}"
}

log "detection: ${CFG}"
train_with_resume "${RUNS}"
