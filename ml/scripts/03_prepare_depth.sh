#!/usr/bin/env bash
# Depth labels for the anti-spoof branch. Runs after 01, before 21 (KEHOACH 3).
set -euo pipefail
cd "$(dirname "$0")/.."

SHARDS=data/interim/antispoof/celeba_spoof_crops
OUT=data/interim/antispoof/depth_maps
MODEL=data/interim/antispoof/depth_model/depth_anything_v2_small.onnx
REPO=onnx-community/depth-anything-v2-small
FILE=onnx/model.onnx

if [ ! -f "$MODEL" ]; then
  mkdir -p "$(dirname "$MODEL")"
  .venv/bin/python - "$REPO" "$FILE" "$MODEL" <<'PY'
import shutil
import sys
from huggingface_hub import hf_hub_download

shutil.copy(hf_hub_download(sys.argv[1], sys.argv[2]), sys.argv[3])
PY
fi

# Every folder the train and val splits name; a missing one would train on zeros
# without saying so.
.venv/bin/python -m facepipe.data.prepare.depth_maps \
  --shards "$SHARDS" --model "$MODEL" --out "$OUT" \
  --folders train:0:60 test:0:10 lcc_training lcc_development \
            synth_bonafide synth_webcam synth_ipad synth_samsung synth_print \
            unique_live unique_replay unique_live_val unique_replay_val \
  "$@"
