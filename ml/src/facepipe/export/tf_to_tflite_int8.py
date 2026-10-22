"""Convert a SavedModel to the two rungs the ladder starts with (KEHOACH 3.7).

Q0 is float and only sets the ceiling; the command line writes it. Q1 is full-integer
PTQ, calibrated on real crops by ptq_tflite: without them the converter picks ranges
from noise and the model loses far more than quantisation itself costs.
"""

import argparse
from pathlib import Path


def convert(saved_dir: Path, out: Path, representative=None) -> int:
    """Write one .tflite and return its size in bytes."""
    import tensorflow as tf

    converter = tf.lite.TFLiteConverter.from_saved_model(str(saved_dir))
    if representative is not None:
        converter.optimizations = [tf.lite.Optimize.DEFAULT]
        converter.representative_dataset = representative
        # A float op would land on a kernel ESP-NN cannot accelerate (KEHOACH 3 layer 4).
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
    args = parser.parse_args(argv)

    size = convert(args.saved, args.out)
    print(f"Q0 float  {args.out.name}  {size / 1024.0:.1f} KB")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
