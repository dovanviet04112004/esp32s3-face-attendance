"""Convert a SavedModel to the two rungs the ladder starts with (KEHOACH 3.7).

Q0 is float and only sets the ceiling. Q1 is full-integer PTQ, calibrated on
real crops: without them the converter picks ranges from noise and the model
loses far more than quantisation itself costs.
"""

import argparse
import importlib
from pathlib import Path

# A model name maps to the package owning its graph shape and calibration set.
BRANCH_PACKAGE = {
    "minifasnet_v2_se": "facepipe.tasks.antispoof",
    "yunet": "facepipe.tasks.detection",
    "mobilefacenet": "facepipe.tasks.recognition",
}


def calibration_samples(run: Path, split: str | None, limit: int):
    """Yield what the branch calls a representative sample, for the converter."""
    from facepipe.core.config import load_run_config

    cfg = load_run_config(run)
    package = BRANCH_PACKAGE[cfg.model.name]
    module = importlib.import_module(f"{package}.quant")
    yield from module.calibration_batches(cfg, split, limit)


def convert(saved_dir: Path, out: Path, representative=None) -> int:
    """Write one .tflite and return its size in bytes."""
    import tensorflow as tf

    converter = tf.lite.TFLiteConverter.from_saved_model(str(saved_dir))
    if representative is not None:
        converter.optimizations = [tf.lite.Optimize.DEFAULT]
        converter.representative_dataset = representative
        # Anything the converter cannot take to int8 would land on a float
        # kernel that ESP-NN has no accelerated path for (KEHOACH 3 layer 4).
        converter.target_spec.supported_ops = [tf.lite.OpsSet.TFLITE_BUILTINS_INT8]
        converter.inference_input_type = tf.int8
        converter.inference_output_type = tf.int8
    blob = converter.convert()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(blob)
    return len(blob)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--saved", type=Path, required=True, help="SavedModel directory")
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--run", type=Path, help="run whose split calibrates the ranges")
    parser.add_argument("--split", default=None, help="which split the crops come from")
    parser.add_argument("--samples", type=int, default=300)
    args = parser.parse_args(argv)

    def representative():
        yield from calibration_samples(args.run, args.split, args.samples)

    feed = representative if args.run is not None else None

    size = convert(args.saved, args.out, feed)
    rung = "Q1 int8" if feed is not None else "Q0 float"
    print(f"{rung}  {args.out.name}  {size / 1024.0:.1f} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
