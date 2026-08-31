#!/usr/bin/env bash
#
# Detection teacher: YOLO26m-pose fine-tuned on WIDER FACE with five landmarks.
# The KD arms distil from what this produces, so a teacher below the section 3.7
# target makes those arms untrustworthy rather than merely weaker.
#
# Ultralytics resumes from a run directory rather than a checkpoint path, and it
# restores every argument except a small whitelist, so overrides given here take
# effect only on the first attempt.
#
# Usage:
#   ./scripts/10_train_teacher_det.sh
#   ./scripts/10_train_teacher_det.sh train.epochs=60

set -uo pipefail

ML_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="${ML_ROOT}/.venv/bin/python"
MODULE="facepipe.tasks.detection.teacher.finetune_widerface"
RUNS="${ML_ROOT}/artifacts/detection/runs"
CFG="configs/detection/teacher_yolo26m_pose.yaml"
OVERRIDES=("$@")

# Reserved memory climbs across epochs and WSL pages past the card in silence at
# a fiftyfold cost, so the allocator is told to hand blocks back (TASKS E3-T13).
export PYTORCH_CUDA_ALLOC_CONF="${PYTORCH_CUDA_ALLOC_CONF:-garbage_collection_threshold:0.8,max_split_size_mb:256}"

log()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!!\033[0m %s\n' "$*" >&2; }

# shellcheck source=_resume_loop.sh
source "${ML_ROOT}/scripts/_resume_loop.sh"

[[ -x "${PY}" ]] || { warn "no venv at ${PY}; run 'uv sync' in ml/"; exit 1; }

launch() {
    local run="$1" resume=()
    if [[ -n "${run}" && -f "${run}ultralytics/weights/last.pt" ]]; then
        resume=(--resume "${run%/}")
        log "resuming ${run%/}"
    fi
    cd "${ML_ROOT}" || return 1
    "${PY}" -m "${MODULE}" --cfg "${CFG}" --set "${OVERRIDES[@]}" "${resume[@]}"
}

log "detection teacher: ${CFG}"
train_with_resume "${RUNS}"
