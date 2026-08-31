#!/usr/bin/env bash
#
# One arm of the antispoof ablation in KEHOACH section 3.7. Which arm a run is comes
# from the config: A0 leaves teacher.enabled false, the KD arm switches it on.
# Both arms go through this script so schedule and augmentation cannot drift
# between them.
#
# Usage:
#   ./scripts/21_kd_spoof.sh
#   ./scripts/21_kd_spoof.sh <config> [key=value ...]

set -uo pipefail

ML_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="${ML_ROOT}/.venv/bin/python"
MODULE="facepipe.tasks.antispoof.train_kd"
RUNS="${ML_ROOT}/artifacts/antispoof/runs"
CFG="${1:-configs/antispoof/student_minifasnet.yaml}"
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

log "anti-spoof student: ${CFG}"
train_with_resume "${RUNS}"
