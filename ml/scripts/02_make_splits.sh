#!/usr/bin/env bash
#
# Generate the split files and their SPLIT.md. These are the only thing under
# data/ that git tracks: lose them and no result can be reproduced.
#
# Splits are lists of names, never copies of images. Nothing is written to raw/.
#
# Usage:
#   ./scripts/02_make_splits.sh              # every branch that has data
#   ./scripts/02_make_splits.sh recognition  # one branch
#   ./scripts/02_make_splits.sh --seed 7     # a different draw

set -euo pipefail

ML_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RAW="${ML_ROOT}/data/raw"
INTERIM="${ML_ROOT}/data/interim"
SPLITS="${ML_ROOT}/data/splits"
PY="${ML_ROOT}/.venv/bin/python"
SEED=42
WANTED=()

while [[ $# -gt 0 ]]; do
    case "$1" in
        --seed) SEED="$2"; shift 2 ;;
        -*) echo "unknown flag: $1" >&2; exit 2 ;;
        *) WANTED+=("$1"); shift ;;
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

[[ -x "${PY}" ]] || { warn "no venv at ${PY}; run 'uv sync' in ml/"; exit 1; }

split_detection() {
    local coco="${INTERIM}/detection/widerface_coco/train.json"
    [[ -f "${coco}" ]] || { warn "detection: ${coco} absent, run 01 first"; return 1; }
    log "detection: carving the landmark set out of train"
    "${PY}" -m facepipe.data.make_split \
        --task detection --source "${coco}" --seed "${SEED}" --split-root "${SPLITS}"
}

split_recognition() {
    # Derived from the shards, so it belongs with interim rather than in splits,
    # which git tracks.
    local listing="${INTERIM}/recognition/identities.txt"
    mkdir -p "$(dirname "${listing}")"
    if [[ ! -s "${listing}" ]]; then
        log "recognition: listing identities from the shards"
        "${PY}" - "${INTERIM}/recognition/ms1mv3_shards" "${listing}" <<'PYTHON'
import sys, tarfile
from pathlib import Path

shards = sorted(Path(sys.argv[1]).glob("*.tar"))
seen = set()
for shard in shards:
    with tarfile.open(shard) as handle:
        for member in handle.getmembers():
            if member.name.endswith(".cls"):
                seen.add(handle.extractfile(member).read().decode().strip())
target = Path(sys.argv[2])
target.write_text("\n".join(f"{i}/x.jpg" for i in sorted(seen, key=int)) + "\n", encoding="utf-8")
print(f"{target}: {len(seen)} identities from {len(shards)} shard(s)")
PYTHON
    fi
    log "recognition: identity-disjoint split"
    "${PY}" -m facepipe.data.make_split \
        --task recognition --source "${listing}" --seed "${SEED}" --split-root "${SPLITS}"
}

split_device() {
    local manifest="${RAW}/device/ov5640/manifest.csv"
    if [[ ! -f "${manifest}" ]]; then
        warn "device: no OV5640 captures yet, skipping (E3-T7)"
        return 0
    fi
    log "device: calibration and test_device"
    "${PY}" -m facepipe.data.make_split \
        --task device --source "${manifest}" --seed "${SEED}" --split-root "${SPLITS}"
}

split_antispoof() {
    local xdomain="${RAW}/antispoof/xdomain"
    [[ -d "${xdomain}/lcc_fasd/LCC_FASD" && -d "${xdomain}/synthaspoof/SynthASpoof" ]] ||
        { warn "antispoof: LCC-FASD or SynthASpoof absent under ${xdomain}, run 00 first"; return 1; }
    log "antispoof: listing the two sets folded into the pool"
    "${PY}" -m facepipe.data.make_split \
        --task antispoof --source "${xdomain}" --seed "${SEED}" --split-root "${SPLITS}"
}

wanted detection   && split_detection
wanted antispoof   && split_antispoof
wanted recognition && split_recognition
wanted device      && split_device
log "splits written under data/splits; commit them"
