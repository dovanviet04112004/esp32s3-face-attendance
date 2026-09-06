"""Turn an ONNX graph into a TensorFlow SavedModel, laid out the way TFLM reads.

ONNX carries tensors as NCHW and TFLite wants NHWC, so this step is a layout
change as much as a format change, and it is where the chain usually breaks.
"""

import argparse
import shutil
from pathlib import Path

import numpy as np

# onnx2tf fetches these to compare its own output against the ONNX graph, and
# the copy it downloads carries an object dtype that numpy 2 refuses to load.
SAMPLE_CACHE = "calibration_image_sample_data_20x128x128x3_float32.npy"
SAMPLE_SHAPE = (20, 128, 128, 3)


def seed_sample_cache(where: Path) -> None:
    """Leave a plain float array where onnx2tf looks, so it skips the download."""
    cached = where / SAMPLE_CACHE
    if cached.exists():
        return
    rng = np.random.default_rng(0)
    np.save(cached, rng.random(SAMPLE_SHAPE, dtype=np.float32))


def convert(onnx_path: Path, out_dir: Path) -> Path:
    """Write a SavedModel beside the graph it came from and return its directory."""
    import onnx2tf

    seed_sample_cache(Path.cwd())
    if out_dir.exists():
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    onnx2tf.convert(
        input_onnx_file_path=str(onnx_path),
        output_folder_path=str(out_dir),
        output_signaturedefs=True,
        copy_onnx_input_output_names_to_tflite=True,
        non_verbose=True,
    )
    return out_dir


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--onnx", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True, help="SavedModel directory")
    args = parser.parse_args(argv)

    saved = convert(args.onnx, args.out)
    produced = sorted(p.name for p in saved.glob("*.tflite"))
    print(f"{saved} ready; onnx2tf also left {len(produced)} tflite file(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
