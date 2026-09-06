"""Convert a SavedModel to the two rungs the ladder starts with (KEHOACH 3.8).

Q0 is float and only sets the ceiling. Q1 is full-integer PTQ, calibrated on
real crops: without them the converter picks ranges from noise and the model
loses far more than quantisation itself costs.
"""

import argparse
import importlib
from pathlib import Path

import numpy as np

BRANCH_LOADERS = {
    "minifasnet_v2_se": "facepipe.tasks.antispoof.eval",
    "cdcnpp": "facepipe.tasks.antispoof.eval",
}


def nhwc(batch) -> np.ndarray:
    """Torch hands crops over as NCHW and every TFLite graph here reads NHWC."""
    return np.ascontiguousarray(batch.numpy().transpose(0, 2, 3, 1), dtype=np.float32)


def calibration_samples(run: Path, split: str, limit: int):
    """Yield real crop pairs, one batch at a time, for the converter to measure."""
    from facepipe.core.config import load_config

    cfg = load_config(run / "config.resolved.yaml", [])
    module = importlib.import_module(BRANCH_LOADERS[cfg.model.name])
    loader = module.build_loader(cfg, split)

    taken = 0
    for tight, wide, _labels, _scale in loader:
        for i in range(tight.shape[0]):
            if taken >= limit:
                return
            yield {"tight": nhwc(tight[i : i + 1]), "wide": nhwc(wide[i : i + 1])}
            taken += 1


def convert(saved_dir: Path, out: Path, representative=None) -> int:
    """Write one .tflite and return its size in bytes."""
    import tensorflow as tf

    converter = tf.lite.TFLiteConverter.from_saved_model(str(saved_dir))
    if representative is not None:
        converter.optimizations = [tf.lite.Optimize.DEFAULT]
        converter.representative_dataset = representative
        # Anything the converter cannot take to int8 would land on a float
        # kernel that ESP-NN has no accelerated path for (KEHOACH 3.9).
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

    representative = None
    if args.run is not None:
        from facepipe.core.config import load_config

        cfg = load_config(args.run / "config.resolved.yaml", [])
        split = args.split or cfg.data.params["val_split"]

        def representative():  # noqa: F811  the converter wants a zero-arg callable
            yield from calibration_samples(args.run, split, args.samples)

    size = convert(args.saved, args.out, representative)
    rung = "Q1 int8" if representative is not None else "Q0 float"
    print(f"{rung}  {args.out.name}  {size / 1024.0:.1f} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
