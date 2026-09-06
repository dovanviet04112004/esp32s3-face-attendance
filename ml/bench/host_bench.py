"""Score a .tflite on a real split so a quantisation rung gets a number.

Runs on the host with the same metrics the torch evaluation uses, so a rung's
accuracy is comparable to the Q0 ceiling rather than to itself (KEHOACH 3.8).
"""

import argparse
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))


def quantized(values: np.ndarray, detail: dict) -> np.ndarray:
    """Cast a float batch into whatever the graph's input tensor expects."""
    scale, zero = detail["quantization"]
    if detail["dtype"] == np.float32 or scale == 0:
        return values.astype(np.float32)
    return np.clip(np.round(values / scale) + zero, -128, 127).astype(detail["dtype"])


def dequantized(values: np.ndarray, detail: dict) -> np.ndarray:
    scale, zero = detail["quantization"]
    if detail["dtype"] == np.float32 or scale == 0:
        return values.astype(np.float32)
    return (values.astype(np.float32) - zero) * scale


def scores(model_path: Path, loader, live_index: int, limit: int = 0):
    """Liveness score and truth for every sample the loader yields.

    A limit strides across the split rather than cutting its head off: the
    shards are not shuffled, so the first batches are one class.
    """
    from ai_edge_litert.interpreter import Interpreter

    interpreter = Interpreter(model_path=str(model_path))
    interpreter.allocate_tensors()
    inputs = {}
    for detail in interpreter.get_input_details():
        stem = detail["name"].split(":")[0].split("/")[-1]
        inputs[stem.removeprefix("serving_default_")] = detail
    output = interpreter.get_output_details()[0]

    stride = 1
    if limit:
        wanted = max(1, limit // max(1, loader.batch_size))
        stride = max(1, len(loader) // wanted)

    got: list[float] = []
    truth: list[int] = []
    for step, (tight, wide, labels, _scale) in enumerate(loader):
        if step % stride:
            continue
        if limit and len(got) >= limit:
            break
        for i in range(tight.shape[0]):
            for name, batch in (("tight", tight), ("wide", wide)):
                # A missing name would silently leave one crop at zero, which
                # costs far more accuracy than any quantisation rung.
                detail = inputs[name]
                frame = batch[i : i + 1].numpy().transpose(0, 2, 3, 1)
                interpreter.set_tensor(detail["index"], quantized(frame, detail))
            interpreter.invoke()
            logits = dequantized(interpreter.get_tensor(output["index"])[0], output)
            exp = np.exp(logits - logits.max())
            got.append(float((exp / exp.sum())[live_index]))
        truth.extend(int(v) for v in labels.numpy())
    return np.array(got), np.array(truth)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--run", type=Path, required=True, help="run whose split and config apply")
    parser.add_argument("--split", default=None)
    parser.add_argument("--limit", type=int, default=0, help="0 scores the whole split")
    args = parser.parse_args(argv)

    from facepipe.core.config import load_config
    from facepipe.tasks.antispoof.losses.task_loss import LIVE
    from facepipe.tasks.antispoof.eval import auc, build_loader, equal_error_rate

    cfg = load_config(args.run / "config.resolved.yaml", [])
    split = args.split or cfg.data.params["test_split"]
    live, truth = scores(args.model, build_loader(cfg, split), LIVE, args.limit)

    crossing = equal_error_rate(live, truth)
    area = auc(live, truth)
    print(
        f"{args.model.name}  n={live.size}  auc {area:.4f}  eer {crossing.acer:.4f}"
        f"  threshold {crossing.threshold:.6f}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
