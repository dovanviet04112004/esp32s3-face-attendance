#!/usr/bin/env bash
#
# The quantisation ladder of KEHOACH section 3.8, one run at a time. Q0 is the float
# ceiling and Q1 is per-channel PTQ with BN folding, cross-layer equalisation
# and bias correction. Every rung is scored on the same split so the numbers in
# docs/measurements/antispoof/quant_ladder.md compare against each other.
#
# Usage:
#   ./scripts/30_quantize.sh <run-directory> [more run directories ...]
#   BENCH_LIMIT=0 ./scripts/30_quantize.sh <run>      # score the whole split

set -uo pipefail

ML_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY="${ML_ROOT}/.venv/bin/python"
BRANCH="antispoof"
ART="${ML_ROOT}/artifacts/${BRANCH}"
BENCH_LIMIT="${BENCH_LIMIT:-4000}"
CALIB_SAMPLES="${CALIB_SAMPLES:-300}"

log()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!!\033[0m %s\n' "$*" >&2; }

[[ -x "${PY}" ]] || { warn "no venv at ${PY}; run 'uv sync --extra cu130 --extra export' in ml/"; exit 1; }
[[ $# -gt 0 ]] || { warn "usage: $0 <run-directory> [...]"; exit 1; }

"${PY}" -c "import onnx2tf, tensorflow" 2>/dev/null || {
    warn "the export extra is missing; run:"
    warn "  uv sync --extra cu130 --extra export"
    exit 1
}

ladder() {
    local run="$1"
    local tag
    tag="$(basename "${run}" | cut -d- -f2 | cut -d_ -f1)"
    [[ -f "${run}/ckpt/best.pth" ]] || { warn "no checkpoint under ${run}"; return 1; }

    log "${tag}: torch to onnx"
    "${PY}" -m facepipe.export.to_onnx --run "${run}" \
        --out "${ART}/onnx/student_fp32_${tag}.onnx" || return 1

    log "${tag}: onnx to savedmodel"
    "${PY}" -m facepipe.export.onnx_to_tf \
        --onnx "${ART}/onnx/student_fp32_${tag}.onnx" \
        --out "${ART}/tf/student_${tag}" || return 1

    log "${tag}: Q0, the float ceiling"
    "${PY}" -m facepipe.export.tf_to_tflite_int8 \
        --saved "${ART}/tf/student_${tag}" \
        --out "${ART}/tflite/minifasnet_fp32_${tag}.tflite" || return 1

    log "${tag}: Q1, fold then equalise then correct bias"
    "${PY}" -m facepipe.compress.quant.ptq_tflite --run "${run}" \
        --out "${ART}/tflite/minifasnet_int8_q1_${tag}.tflite" \
        --work "${ART}/tf/q1_${tag}" --samples "${CALIB_SAMPLES}" || return 1

    log "${tag}: which operators esp-nn accelerates"
    "${PY}" -m facepipe.export.tflite_op_check \
        --model "${ART}/tflite/minifasnet_int8_q1_${tag}.tflite" \
        --out "${ART}/reports/op_check_${tag}.txt"

    for model in "minifasnet_fp32_${tag}" "minifasnet_int8_q1_${tag}"; do
        log "${tag}: scoring ${model}"
        "${PY}" "${ML_ROOT}/bench/host_bench.py" \
            --model "${ART}/tflite/${model}.tflite" --run "${run}" --limit "${BENCH_LIMIT}"
    done
}

failed=0
for run in "$@"; do
    ladder "${run}" || { warn "ladder stopped on ${run}"; failed=1; }
done

log "numbers belong in docs/measurements/${BRANCH}/quant_ladder.md, not in artifacts"
exit "${failed}"
