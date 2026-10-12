"""The detection branch's hooks of the ESP-DL ladder (KEHOACH 3.7): calibration, probe, ruler.

The converter measures activation ranges on whatever it is fed, so the crops
here come through the same letterbox the training split uses. Ranges taken
from noise cost more accuracy than the quantisation itself.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import torch

# One step of the main ruler, 0.1 point of AP (KEHOACH 3.7 selection rule).
RESOLUTION = 0.001


def calibration_batches(cfg: object, split: str | None, limit: int):
    """Yield real images one at a time, keyed by the graph's input name."""
    from .data import WiderFaceDataset, collate

    dataset = WiderFaceDataset(
        coco=Path(cfg.data.params["coco"]),
        images_root=Path(cfg.data.params["images"]),
        split_file=Path(split or cfg.data.split_files[1]),
        input_hw=tuple(cfg.model.input_hw),
        train=False,
        seed=cfg.run.seed,
    )
    loader = torch.utils.data.DataLoader(dataset, batch_size=1, collate_fn=collate)
    for taken, batch in enumerate(loader):
        if taken >= limit:
            return
        images = batch[0].numpy().transpose(0, 2, 3, 1)
        yield {"image": np.ascontiguousarray(images, dtype=np.float32)}


def torch_batches(cfg: object, split: str | None, samples: int):
    """One batch shaped the way the model's own forward reads it."""
    from .data import WiderFaceDataset, collate

    dataset = WiderFaceDataset(
        coco=Path(cfg.data.params["coco"]),
        images_root=Path(cfg.data.params["images"]),
        split_file=Path(split or cfg.data.split_files[1]),
        input_hw=tuple(cfg.model.input_hw),
        train=False,
        seed=cfg.run.seed,
    )
    loader = torch.utils.data.DataLoader(dataset, batch_size=samples, collate_fn=collate)
    for batch in loader:
        yield batch[0]
        return


def probe_inputs(cfg: object, frames, count: int) -> np.ndarray:
    """The first count frames of test_device letterboxed into the graph's input, float NCHW."""
    from PIL import Image

    from .data import letterbox_params

    height, width = (int(v) for v in cfg.model.input_hw)
    out = []
    for _name, _label, rgb in frames[:count]:
        frame_h, frame_w = rgb.shape[:2]
        scale, pad_x, pad_y = letterbox_params((frame_h, frame_w), (height, width))
        canvas = Image.new("RGB", (width, height))
        resized = Image.fromarray(rgb).resize((round(frame_w * scale), round(frame_h * scale)))
        canvas.paste(resized, (pad_x, pad_y))
        out.append(np.asarray(canvas, dtype=np.float32) / 255.0)
    return np.stack(out).transpose(0, 3, 1, 2)


def score(runner, cfg: object) -> dict[str, float]:
    """AP on WIDER val at every setting and at the face size the kiosk serves, from the runner."""
    from facepipe.compress.quant.ladder import data_path

    from .eval import (
        SERVICE_FACE_PX,
        SETTINGS,
        evaluate,
        load_ground_truth,
        predict_images,
        size_subset,
    )
    from .model.head import HeadOutput

    class AsHead:
        def eval(self):
            return self

        def __call__(self, tensor: torch.Tensor) -> HeadOutput:
            outs = [torch.from_numpy(o) for o in runner(tensor.cpu().numpy())]
            return HeadOutput(cls=outs[0:3], bbox=outs[3:6], kps=outs[6:9])

    wider = data_path("detection.widerface")
    input_hw = tuple(int(v) for v in cfg.model.input_hw)
    truth = load_ground_truth(wider / "eval_tools/ground_truth")
    images = wider / "WIDER_val/images"
    served = f"ge{SERVICE_FACE_PX:g}px"
    truth.keep[served] = size_subset(truth, images, input_hw, SERVICE_FACE_PX)
    found = predict_images(AsHead(), truth.names, images, input_hw, torch.device("cpu"))
    ap = evaluate({n: d.xywh_with_score() for n, d in found.items()}, truth, (*SETTINGS, served))
    return {f"ap_{key}": float(ap[key]) for key in (*SETTINGS, served)}


def served_key() -> str:
    from .eval import SERVICE_FACE_PX

    return f"ap_ge{SERVICE_FACE_PX:g}px"


def rank(metrics: dict[str, float]) -> tuple:
    """The branch's ruler: AP at the face size the kiosk serves."""
    return (metrics[served_key()],)


def gate(metrics: dict[str, float], ceiling: dict[str, float]) -> bool:
    """KEHOACH 3.7: AP at the served size within 1% of Q0."""
    return metrics[served_key()] >= 0.99 * ceiling[served_key()]


def headline(metrics: dict[str, float]) -> str:
    return "  ".join(f"{key.removeprefix('ap_')} AP {value:.4f}" for key, value in metrics.items())
