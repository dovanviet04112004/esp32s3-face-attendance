#!/usr/bin/env bash
#
# One arm of the detection ablation in KEHOACH section 3.7. Which arm a run is
# comes from the config: A0 leaves teacher.enabled false, the KD arms switch it
# on. Both arms go through this script so schedule and augmentation cannot drift
# between them.
#
# Usage:
#   ./scripts/20_kd_det.sh                                   # A0, the baseline
#   ./scripts/20_kd_det.sh configs/detection/kd.yaml          # a KD arm
#   ./scripts/20_kd_det.sh configs/detection/student_yunet.yaml train.epochs=50

set -uo pipefail

ML_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="${ML_ROOT}/.venv/bin/python"
MODULE="facepipe.tasks.detection.train_kd"
RUNS="${ML_ROOT}/artifacts/detection/runs"
CFG="${1:-configs/detection/student_yunet.yaml}"
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

log "detection student: ${CFG}"
train_with_resume "${RUNS}"
