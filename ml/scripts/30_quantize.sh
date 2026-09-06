#!/usr/bin/env bash
#
# The quantisation ladder of KEHOACH section 3.8, one run at a time. Q0 is the float
# ceiling and Q1 is per-channel PTQ with BN folding, cross-layer equalisation
# and bias correction. Every rung is scored on the same split so the numbers in
# docs/measurements/<branch>/quant_ladder.md compare against each other.
#
# Which branch a run belongs to comes from its own frozen config, so one
# invocation can walk runs from all three.
#
# Usage:
#   ./scripts/30_quantize.sh <run-directory> [more run directories ...]
#   BENCH_LIMIT=0 ./scripts/30_quantize.sh <run>      # score the whole split
#   SCORE=0 ./scripts/30_quantize.sh <run>            # export only, do not score

set -uo pipefail

ML_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="${ML_ROOT}/.venv/bin/python"
BENCH_LIMIT="${BENCH_LIMIT:-4000}"
CALIB_SAMPLES="${CALIB_SAMPLES:-300}"
SCORE="${SCORE:-1}"

log()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!!\033[0m %s\n' "$*" >&2; }

[[ -x "${PY}" ]] || { warn "no venv at ${PY}; run 'uv sync --extra cu130 --extra export' in ml/"; exit 1; }
[[ $# -gt 0 ]] || { warn "usage: $0 <run-directory> [...]"; exit 1; }

"${PY}" -c "import onnx2tf, tensorflow" 2>/dev/null || {
    warn "the export extra is missing; run:"
    warn "  uv sync --extra cu130 --extra export"
    exit 1
}

read_branch() {
    "${PY}" -c '
import sys
from pathlib import Path
from facepipe.core.config import load_config
from facepipe.export.tf_to_tflite_int8 import BRANCH_PACKAGE
cfg = load_config(Path(sys.argv[1]) / "config.resolved.yaml", [])
print(BRANCH_PACKAGE[cfg.model.name].rsplit(".", 1)[-1], cfg.model.name)
' "$1"
}

ladder() {
    local run="$1"
    local tag branch model art
    tag="$(basename "${run}" | cut -d- -f2 | cut -d_ -f1)"
    [[ -f "${run}/ckpt/best.pth" ]] || { warn "no checkpoint under ${run}"; return 1; }
    read -r branch model < <(read_branch "${run}") || return 1
    [[ -n "${branch}" ]] || { warn "cannot tell which branch ${run} belongs to"; return 1; }
    art="${ML_ROOT}/artifacts/${branch}"
    log "${tag}: branch ${branch}, model ${model}"

    log "${tag}: torch to onnx"
    "${PY}" -m facepipe.export.to_onnx --run "${run}" \
        --out "${art}/onnx/student_fp32_${tag}.onnx" || return 1

    log "${tag}: onnx to savedmodel"
    "${PY}" -m facepipe.export.onnx_to_tf \
        --onnx "${art}/onnx/student_fp32_${tag}.onnx" \
        --out "${art}/tf/student_${tag}" || return 1

    log "${tag}: Q0, the float ceiling"
    "${PY}" -m facepipe.export.tf_to_tflite_int8 \
        --saved "${art}/tf/student_${tag}" \
        --out "${art}/tflite/${model}_fp32_${tag}.tflite" || return 1

    log "${tag}: Q1, fold then equalise then correct bias"
    "${PY}" -m facepipe.compress.quant.ptq_tflite --run "${run}" \
        --out "${art}/tflite/${model}_int8_q1_${tag}.tflite" \
        --work "${art}/tf/q1_${tag}" --samples "${CALIB_SAMPLES}" || return 1

    log "${tag}: which operators esp-nn accelerates"
    "${PY}" -m facepipe.export.tflite_op_check \
        --model "${art}/tflite/${model}_int8_q1_${tag}.tflite" \
        --out "${art}/reports/op_check_${tag}.txt"

    [[ "${SCORE}" == "1" ]] || return 0
    if [[ "${branch}" != "antispoof" ]]; then
        warn "${tag}: host_bench.py scores the antispoof branch only, skipping"
        return 0
    fi
    for file in "${model}_fp32_${tag}" "${model}_int8_q1_${tag}"; do
        log "${tag}: scoring ${file}"
        "${PY}" "${ML_ROOT}/bench/host_bench.py" \
            --model "${art}/tflite/${file}.tflite" --run "${run}" --limit "${BENCH_LIMIT}"
    done
}

failed=0
for run in "$@"; do
    ladder "${run}" || { warn "ladder stopped on ${run}"; failed=1; }
done

log "numbers belong in docs/measurements/<branch>/quant_ladder.md, not in artifacts"
exit "${failed}"
