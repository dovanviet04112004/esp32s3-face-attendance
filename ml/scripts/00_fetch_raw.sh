#!/usr/bin/env bash
#
# Fetch every dataset, then fill in each manifest from what is actually on disk.
#
# Three access kinds: auto pulls over plain HTTP, hf pulls a Hub mirror, manual
# needs a human because the source sits behind a Drive link or a signed form.
#
# Digests and counts come from the files, never from a person typing them.
#
# Usage:
#   ./scripts/00_fetch_raw.sh              # fetch the automatable ones, verify all
#   ./scripts/00_fetch_raw.sh --verify     # verify only, no download
#   ./scripts/00_fetch_raw.sh widerface    # one dataset by name

set -euo pipefail

ML_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RAW="${ML_ROOT}/data/raw"

# HF_TOKEN lifts the anonymous rate limit. .env is gitignored; .env.example is the template.
if [[ -f "${ML_ROOT}/.env" ]]; then
    set -a; . "${ML_ROOT}/.env"; set +a
fi
VERIFY_ONLY=0
WANTED=()

for arg in "$@"; do
    case "$arg" in
        --verify) VERIFY_ONLY=1 ;;
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

# Reads expects/ from the manifest, digests whatever exists, and writes back
# sha256, counts, downloaded and verified.
record_manifest() {
    local dir="$1"
    python3 - "$dir" <<'PYTHON'
import hashlib
import os
import sys
from datetime import date
from pathlib import Path

import yaml

root = Path(sys.argv[1])
manifest_path = root / "manifest.yaml"
manifest = yaml.safe_load(manifest_path.read_text(encoding="utf-8"))


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


digests: dict[str, str] = {}
missing: list[str] = []
for item in manifest.get("expects") or []:
    target = root / item
    if target.is_file():
        digests[item] = digest(target)
    elif target.is_dir() and any(p.is_file() for p in target.rglob("*")):
        digests[item] = "<directory>"
    else:
        missing.append(item)

bookkeeping = {"manifest.yaml", ".gitkeep"}
image_suffixes = {".jpg", ".jpeg", ".png"}
files = images = 0
# followlinks: the dataset directories are symlinks onto the data drive.
for folder, _dirs, names in os.walk(root, followlinks=True):
    for name in names:
        if name in bookkeeping:
            continue
        files += 1
        if Path(name).suffix.lower() in image_suffixes:
            images += 1
counts = {"files": files}
if images:
    counts["images"] = images

manifest["sha256"] = digests
manifest["counts"] = counts
manifest["verified"] = not missing
if not missing:
    manifest["downloaded"] = date.today().isoformat()

manifest_path.write_text(
    yaml.safe_dump(manifest, sort_keys=False, allow_unicode=True), encoding="utf-8"
)

name = manifest.get("name", root.name)
if missing:
    print(f"  {name}: MISSING {', '.join(missing)}")
else:
    print(f"  {name}: verified, {counts['files']} file(s)")
PYTHON
}

# Downloads are archives read once, so they land on the cold drive; only what a
# training loop rereads is worth the fast tier (KEHOACH section 4.4.1).
COLD_DRIVE="$(python3 -c \
    "import sys,yaml;print(yaml.safe_load(open(sys.argv[1]))['cold_drive'])" \
    "${ML_ROOT}/configs/common/paths.yaml")"

payload_dir() {
    local ds="$1"
    echo "${COLD_DRIVE}/raw/${ds#"${RAW}/"}"
}

# One symlink per top-level entry on the drive. Deriving the list from expects
# instead would link only what that list happens to name, leaving the other 1384
# glint360k shards unreachable from the repo path a loader globs.
link_payload() {
    local ds="$1" src
    src="$(payload_dir "${ds}")"
    python3 - "${ds}" "${src}" <<'PYTHON'
import os
import sys
from pathlib import Path

dest, src = Path(sys.argv[1]), Path(sys.argv[2])
if not src.is_dir():
    sys.exit(0)
dest.mkdir(parents=True, exist_ok=True)

hub_bookkeeping = {".cache", ".gitattributes", ".gitkeep", "README.md"}
own = {"manifest.yaml", "manifest.csv"}

linked: dict[str, Path] = {}
for child in list(dest.iterdir()):
    if not child.is_symlink():
        continue
    if not child.exists():
        child.unlink()
        continue
    linked[os.path.realpath(child)] = child

made = 0
for entry in sorted(src.iterdir()):
    if entry.name in hub_bookkeeping or entry.name in own:
        continue
    # NTFS folds case, so the drive reports Data where the loader opens data.
    # Keeping the existing link avoids a second name for one directory.
    if os.path.realpath(entry) in linked:
        continue
    link = dest / entry.name
    if link.is_symlink() or link.exists():
        continue
    link.symlink_to(entry)
    made += 1

print(f"  linked {made} new entry(ies)" if made else "  links already complete")
PYTHON
}

fetch_widerface() {
    local ds="${RAW}/detection/widerface" dest
    dest="$(payload_dir "${ds}")"
    local base="https://huggingface.co/datasets/wider_face/resolve/main/data"
    local archive
    for archive in WIDER_train.zip WIDER_val.zip WIDER_test.zip wider_face_split.zip; do
        if [[ -f "${dest}/${archive}" ]]; then
            log "widerface: ${archive} already downloaded"
        else
            log "widerface: downloading ${archive}"
            curl -fL --retry 3 --retry-delay 5 -C - \
                -o "${dest}/${archive}" "${base}/${archive}" || {
                warn "${archive} failed; rerun to resume"
                continue
            }
        fi
        # Unpacking only when the directory is absent. Redoing it rewrites 3.6 GB
        # over drvfs, which starves any training run reading the same mount.
        if [[ -d "${dest}/${archive%.zip}" ]]; then
            log "widerface: ${archive%.zip} already unpacked"
        else
            log "widerface: unpacking ${archive}"
            unzip -q -o "${dest}/${archive}" -d "${dest}"
        fi
    done

    # The Easy/Medium/Hard subsets are not in the HuggingFace mirror, and without
    # them the plan's 0.80 hard-track target has no scale to be measured on. The
    # authors' own host serves them at about 1 KB/s; this mirror carries the same
    # four files and is what the face detection papers evaluate against.
    local truth="${dest}/eval_tools/ground_truth"
    local base="https://raw.githubusercontent.com/Linzaer"
    base="${base}/Ultra-Light-Fast-Generic-Face-Detector-1MB/master/widerface_evaluate/ground_truth"
    mkdir -p "${truth}"
    local name
    for name in wider_face_val.mat wider_easy_val.mat wider_medium_val.mat wider_hard_val.mat; do
        [[ -s "${truth}/${name}" ]] && continue
        log "widerface: downloading ${name}"
        curl -fL --retry 3 --retry-delay 5 -o "${truth}/${name}" "${base}/${name}" ||
            warn "${name} failed; rerun to resume"
    done
}

# Mirrors on the Hub download straight into the data drive the symlinks point at.
hf_cli() {
    if [[ -x "${ML_ROOT}/.venv/bin/hf" ]]; then
        echo "${ML_ROOT}/.venv/bin/hf"
    elif command -v hf >/dev/null; then
        command -v hf
    else
        return 1
    fi
}

fetch_hf() {
    local ds="$1" repo="$2" dest cli
    dest="$(payload_dir "${ds}")"
    cli="$(hf_cli)" || {
        warn "hf CLI absent. Run 'uv sync' in ml/, or pip install huggingface_hub"
        return 1
    }
    log "${repo} -> ${dest}"
    HF_HOME="${ML_ROOT}/data/.hf-cache" "${cli}" download "${repo}" \
        --repo-type dataset --local-dir "${dest}"
}

# The RetinaFace landmarks live only on Google Drive. The file id belongs to the
# manifest, which is where every dataset source is recorded (section 4.9).
fetch_gdrive() {
    local ds="$1" dest drive_id archive
    dest="$(payload_dir "${ds}")"
    read -r drive_id archive < <(python3 -c "
import sys, yaml
m = yaml.safe_load(open(sys.argv[1]))
print(m['drive_id'], m['archive'])" "${ds}/manifest.yaml")

    if [[ -f "${dest}/${archive}" ]]; then
        log "${archive} already downloaded"
    else
        "${ML_ROOT}/.venv/bin/python" -m gdown "${drive_id}" -O "${dest}/${archive}" || {
            warn "gdown failed; run 'uv sync' in ml/ or fetch ${archive} by hand"
            return 1
        }
    fi
    unzip -q -o "${dest}/${archive}" -d "${dest}"
}

manual_notice() {
    local dir="$1" name="$2"
    local url
    url="$(python3 -c "import sys,yaml;print(yaml.safe_load(open(sys.argv[1]))['source_url'])" \
        "${dir}/manifest.yaml")"
    warn "${name} is fetched by hand: get it from ${url}"
    warn "  then unpack it into $(payload_dir "${dir}") and rerun with --verify"
}

DATASETS=(
    "detection/widerface:widerface:auto"
    "detection/retinaface_labels:retinaface_labels:gdrive"
    "antispoof/celeba_spoof:celeba_spoof:hf:Ar4ikov/celebA_spoof"
    "antispoof/xdomain/nuaa:nuaa:hf:akahana/anti-spoofing-nuaaaa"
    "antispoof/xdomain/unique_live:unique_live:hf:UniqueData/anti-spoofing_Real"
    "antispoof/xdomain/unique_replay:unique_replay:hf:UniqueData/anti-spoofing_replay"
    "antispoof/xdomain/axon_masks:axon_masks:hf:AxonData/face-anti-spoofing-dataset"
    "antispoof/xdomain/lcc_fasd:lcc_fasd:manual"
    "antispoof/xdomain/synthaspoof:synthaspoof:manual"
    "recognition/ms1mv3:ms1mv3:hf:gaunernst/ms1mv3-recordio"
    "recognition/glint360k:glint360k:hf:gaunernst/glint360k-wds-gz"
    "recognition/benchmarks:recognition_benchmarks:hf:gaunernst/face-recognition-eval"
)

incomplete=0
for entry in "${DATASETS[@]}"; do
    IFS=":" read -r rel name access repo <<< "${entry}:"
    wanted "${name}" || continue
    dir="${RAW}/${rel}"
    [[ -f "${dir}/manifest.yaml" ]] || { warn "no manifest at ${dir}"; continue; }

    if [[ "${VERIFY_ONLY}" -eq 0 ]]; then
        mkdir -p "$(payload_dir "${dir}")"
        case "${access}" in
            auto) "fetch_${name}" ;;
            hf)     fetch_hf "${dir}" "${repo}" ;;
            gdrive) fetch_gdrive "${dir}" ;;
            manual) manual_notice "${dir}" "${name}" ;;
        esac
    fi
    log "${name}"
    link_payload "${dir}"
    if ! record_manifest "${dir}"; then
        incomplete=1
    fi
    if ! python3 -c "import sys,yaml;sys.exit(0 if yaml.safe_load(open(sys.argv[1]))['verified'] else 1)" \
        "${dir}/manifest.yaml"; then
        incomplete=1
        [[ "${access}" == "manual" ]] && manual_notice "${dir}" "${name}"
    fi
done

if [[ "${incomplete}" -eq 1 ]]; then
    warn "some datasets are incomplete; rerun with --verify after unpacking them"
    exit 1
fi
log "every requested dataset is present and recorded"
