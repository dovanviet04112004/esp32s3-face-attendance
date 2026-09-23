"""Golden cases for the detector decode and its suppression (KEHOACH 4.3).

Head tensors are drawn at random under the deployed quantisation rather than
run through the model, so a case can be dense enough to hit the 32-candidate
cap, sparse, or empty - the three ways the device loop ends.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import numpy as np
import torch

from facepipe.export.emit_golden import write_case
from facepipe.tasks.detection.model.anchors import feature_sizes, pyramid_priors

from .decode import bbox_decode, kps_decode
from .nms import nms, top_k

INPUT_HW = (120, 160)
STRIDES = (8, 16, 32)
CANDIDATES = 32
NMS_IOU = 0.3
# Output quantisation of the deployed yunet_int8, one triple per level.
LEVEL_QUANT = {
    8: {"cls": (0.04347286, 98), "box": (0.00914454, -57), "kps": (0.01351811, -48)},
    16: {"cls": (0.06135493, 99), "box": (0.01207780, -42), "kps": (0.01943806, -32)},
    32: {"cls": (0.02877619, 85), "box": (0.01116470, -39), "kps": (0.02041816, -25)},
}
# The same heads in yunet_s8.espdl: scale 2^exponent, zero point 0 (KEHOACH 3 layer 4).
ESPDL_EXPONENTS = {8: {"cls": -4, "box": -6, "kps": -6}, 16: {"cls": -3, "box": -6, "kps": -5},
                   32: {"cls": -4, "box": -6, "kps": -5}}
ESPDL_QUANT = {stride: {role: (2.0**exponent, 0) for role, exponent in roles.items()}
               for stride, roles in ESPDL_EXPONENTS.items()}
CHANNELS = {"cls": 1, "box": 4, "kps": 10}


def dequantized(values: np.ndarray, scale: float, zero_point: int) -> torch.Tensor:
    return torch.from_numpy(((values.astype(np.float32) - zero_point) * scale).astype(np.float32))


def decoded(tensors: dict[str, np.ndarray], min_score: float, quant: dict) -> dict[str, np.ndarray]:
    """Threshold, cap and suppress, the order decode_faces runs them in."""
    sizes = feature_sizes(INPUT_HW, STRIDES)
    priors = torch.cat(pyramid_priors(sizes, STRIDES))
    parts: dict[str, list[torch.Tensor]] = {"cls": [], "box": [], "kps": []}
    for stride, (rows, cols) in zip(STRIDES, sizes, strict=True):
        for role in parts:
            scale, zero = quant[stride][role]
            flat = tensors[f"{role}_{stride}"].reshape(rows * cols, CHANNELS[role])
            parts[role].append(dequantized(flat, scale, zero))

    logits = torch.cat(parts["cls"])[:, 0]
    scores = torch.sigmoid(logits).numpy()
    boxes = bbox_decode(priors, torch.cat(parts["box"])).numpy()
    points = kps_decode(priors, torch.cat(parts["kps"])).numpy()

    above = np.nonzero(scores >= min_score)[0]
    above = above[top_k(scores[above], CANDIDATES)] if above.size else above
    keep = nms(boxes[above], scores[above], NMS_IOU) if above.size else np.empty(0, dtype=np.int64)
    chosen = above[keep]
    return {
        "scores": scores[chosen].astype(np.float32),
        "boxes": boxes[chosen].astype(np.float32).reshape(-1, 4),
        "landmarks": points[chosen].astype(np.float32).reshape(-1, 10),
    }


def head_tensors(rng: np.random.Generator, cls_bias: int) -> dict[str, np.ndarray]:
    """Nine int8 maps; cls_bias moves how many cells clear the floor."""
    out = {}
    for stride, (rows, cols) in zip(STRIDES, feature_sizes(INPUT_HW, STRIDES), strict=True):
        for role, channels in CHANNELS.items():
            low, high = (-128, 128) if role != "cls" else (-128, cls_bias)
            out[f"{role}_{stride}"] = rng.integers(low, high, (rows, cols, channels)).astype(np.int8)
    return out


def emit_decode(root: Path, rng: np.random.Generator, espdl_rng: np.random.Generator) -> int:
    # 128 lets a tenth of the cells clear 0.5, 99 leaves a handful, 90 leaves none.
    cases = [(128, 0.5, LEVEL_QUANT, rng), (99, 0.5, LEVEL_QUANT, rng), (90, 0.9, LEVEL_QUANT, rng)]
    # Its own generator keeps the three TFLite cases above byte for byte.
    cases.append((16, 0.5, ESPDL_QUANT, espdl_rng))
    for index, (cls_bias, min_score, quant, source) in enumerate(cases):
        tensors = head_tensors(source, cls_bias)
        expected = decoded(tensors, min_score, quant)
        payload = {f"{name}": value for name, value in tensors.items()}
        # Row order is level then role, which is how the board walks them back.
        payload["quant"] = np.array(
            [[quant[s][r][0], float(quant[s][r][1])] for s in STRIDES for r in CHANNELS],
            dtype=np.float32,
        )
        payload["min_score"] = np.array([min_score], dtype=np.float32)
        payload["found"] = np.array([len(expected["scores"])], dtype=np.int32)
        payload.update(expected)
        write_case(root / "decode" / f"case_{index:03d}.gold", payload)
    return len(cases)


def emit_nms(root: Path, rng: np.random.Generator) -> int:
    """Box sets for the shapes suppression has to separate."""
    stacked = np.array([[10, 10, 60, 60], [12, 12, 62, 62], [14, 14, 64, 64]], dtype=np.float32)
    apart = np.array([[0, 0, 40, 40], [80, 0, 120, 40], [0, 60, 40, 100]], dtype=np.float32)
    touching = np.array([[0, 0, 40, 40], [28, 0, 68, 40], [39, 0, 79, 40]], dtype=np.float32)
    nested = np.array([[0, 0, 100, 100], [30, 30, 70, 70], [200, 200, 240, 240]], dtype=np.float32)
    for index, boxes in enumerate([stacked, apart, touching, nested]):
        scores = np.linspace(0.95, 0.55, len(boxes)).astype(np.float32)
        keep = nms(boxes, scores, NMS_IOU)
        write_case(
            root / "nms" / f"case_{index:03d}.gold",
            {
                "boxes": boxes,
                "scores": scores,
                "kept": np.array([len(keep)], dtype=np.int32),
                "kept_boxes": boxes[keep].reshape(-1, 4),
            },
        )
    return 4


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, default=Path("contracts/golden/detection"))
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args(argv)

    rng = np.random.default_rng(args.seed)
    espdl_rng = np.random.default_rng(args.seed + 1)
    print(f"{args.out / 'decode'}: {emit_decode(args.out, rng, espdl_rng)} case(s)")
    print(f"{args.out / 'nms'}: {emit_nms(args.out, rng)} case(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
