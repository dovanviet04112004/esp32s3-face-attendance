#!/usr/bin/env bash
#
# Train the CDCN++ teacher on CelebA-Spoof. Arm A3 of KEHOACH section 3.7 distils
# from whatever this produces, so its ACER on the upstream valid split is what
# decides whether that arm is worth running at all.
#
# Usage:
#   ./scripts/11_train_teacher_spoof.sh
#   ./scripts/11_train_teacher_spoof.sh <config> [key=value ...]

set -uo pipefail

ML_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="${ML_ROOT}/.venv/bin/python"
MODULE="facepipe.tasks.antispoof.teacher.train_teacher"
RUNS="${ML_ROOT}/artifacts/antispoof/runs"
CFG="${1:-configs/antispoof/teacher_cdcnpp.yaml}"
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

log "anti-spoof teacher (CDCN++): ${CFG}"
train_with_resume "${RUNS}"
