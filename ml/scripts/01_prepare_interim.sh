#!/usr/bin/env bash
#
# raw -> interim. Every step is idempotent and skippable, because these run for
# hours over tens of gigabytes and a rerun should not redo finished work.
#
# Glint360K never appears here: its mirror already ships webdataset shards.
#
# Usage:
#   ./scripts/01_prepare_interim.sh              # every branch
#   ./scripts/01_prepare_interim.sh detection    # one branch
#   ./scripts/01_prepare_interim.sh --force      # redo even if the output exists

set -euo pipefail

ML_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RAW="${ML_ROOT}/data/raw"
INTERIM="${ML_ROOT}/data/interim"
PY="${ML_ROOT}/.venv/bin/python"
FORCE=0
WANTED=()

for arg in "$@"; do
    case "$arg" in
        --force) FORCE=1 ;;
        -*) echo "unknown flag: $arg" >&2; exit 2 ;;
        *) WANTED+=("$arg") ;;
    esac
done

wanted() {
    [[ ${#WANTED[@]} -eq 0 ]] && return 0
    local name
    for name in "${WANTED[@]}"; do [[ "$name" == "$1" ]] && return 0; done
    return 1
}

log()  { printf '\033[36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!!\033[0m %s\n' "$*" >&2; }
skip() { printf '\033[32m--\033[0m %s\n' "$*"; }

[[ -x "${PY}" ]] || { warn "no venv at ${PY}; run 'uv sync' in ml/"; exit 1; }

# Treats a non-empty output as done, so an interrupted run resumes by branch.
done_already() {
    [[ "${FORCE}" -eq 0 ]] && [[ -e "$1" ]] && [[ -s "$1" || -n "$(ls -A "$1" 2>/dev/null)" ]]
}

# Reads one dotted key out of the config that owns dataset paths (KEHOACH 4.9).
paths_get() {
    "${PY}" -c "import functools,sys,yaml; print(functools.reduce(lambda node, key: node[key], sys.argv[2].split('.'), yaml.safe_load(open(sys.argv[1]))))" \
        "${ML_ROOT}/configs/common/paths.yaml" "$1"
}

# A rerun that produces fewer shards would leave the extra ones from the previous
# run behind, and a loader globbing the directory would read them as data.
reset_output() {
    [[ "${FORCE}" -eq 1 ]] || return 0
    local target="$1"
    [[ -e "${target}" ]] || return 0
    log "force: clearing ${target#"${ML_ROOT}/"}"
    rm -rf "${target:?}"
}

prepare_detection() {
    local out="${INTERIM}/detection/widerface_coco"
    mkdir -p "${out}"
    local split
    for split in train val; do
        local target="${out}/${split}.json"
        reset_output "${target}"
        if done_already "${target}"; then
            skip "detection/${split}.json already built"
            continue
        fi
        log "detection: ${split} -> COCO"
        "${PY}" -m facepipe.data.prepare.widerface_to_coco \
            --labels "${RAW}/detection/retinaface_labels/${split}/label.txt" \
            --images "${RAW}/detection/widerface/WIDER_${split}/images" \
            --out "${target}"
    done
}

prepare_antispoof() {
    local out="${INTERIM}/antispoof/celeba_spoof_crops"
    reset_output "${out}"
    if done_already "${out}"; then
        skip "antispoof crops already built"
        return
    fi
    local detector
    detector="${ML_ROOT}/$(paths_get antispoof.detector)"
    [[ -f "${detector}" ]] || {
        warn "no detection checkpoint at ${detector#"${ML_ROOT}/"}"
        warn "antispoof crops are cut by the detector, so train detection first (KEHOACH 3)"
        exit 1
    }
    log "antispoof: CelebA-Spoof parquet -> crops 1.0x and 2.7x, faces from the detector"
    "${PY}" -m facepipe.data.prepare.celeba_spoof_parquet \
        --root "${RAW}/antispoof/celeba_spoof" \
        --out "${out}" \
        --detector "${detector}"
}

prepare_recognition() {
    local out="${INTERIM}/recognition/ms1mv3_shards"
    reset_output "${out}"
    if done_already "${out}"; then
        skip "recognition shards already built"
        return
    fi
    log "recognition: MS1MV3 RecordIO -> webdataset shards"
    "${PY}" -m facepipe.data.prepare.recordio_to_wds \
        --rec "${RAW}/recognition/ms1mv3/train.rec" \
        --idx "${RAW}/recognition/ms1mv3/train.idx" \
        --out "${out}"
}

started="$(date +%s)"
wanted detection   && prepare_detection
wanted antispoof   && prepare_antispoof
wanted recognition && prepare_recognition
log "interim ready in $(( ($(date +%s) - started) / 60 )) minute(s)"
