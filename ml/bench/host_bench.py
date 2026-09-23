"""Score a model on the host with its branch's own metric, so a rung compares to the Q0 ceiling.

Three runtimes: onnx (the float graph), tflite (the file TFLM runs) and espdl (ESP-PPQ's
simulation of the S3 target, which model->test() holds to the chip within one int8 step). Three
branches: WIDER val AP, liveness on a split or on the board's own frames, and TAR@FAR on
the verification benchmarks (KEHOACH 3.7).
"""

import argparse
import importlib
import re
import sys
import tempfile
from pathlib import Path

import numpy as np

ML_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ML_ROOT / "src"))

PREPROC_CPP = "firmware/components/ai_engine/src/antispoof/preproc.cpp"
VISION_KCONFIG = "firmware/components/svc_vision/Kconfig"
DEVICE_FRAMES = "data/splits/device/v1/test_device.txt"
_FACE_SCALE = re.compile(r"kFaceScale\s*=\s*([0-9.]+)f?;")
_LIVE_MIN = re.compile(r"config VISION_SEED_LIVE_MIN_PERMILLE.*?default\s+(\d+)", re.S)


def quantized(values: np.ndarray, detail: dict) -> np.ndarray:
    """Cast a float batch into whatever the graph's input tensor expects."""
    scale, zero = detail["quantization"]
    if detail["dtype"] == np.float32 or scale == 0:
        return values.astype(np.float32)
    # Quantizer in pixels.cpp: float32, times the inverse scale, rint; 2/255 puts pixels on ties.
    inverse = np.float32(1.0) / np.float32(scale)
    q = np.rint(values.astype(np.float32) * inverse) + zero
    return np.clip(q, -128, 127).astype(detail["dtype"])


def reference_interpreter(path: Path):
    """The file on the kernels TFLM and esp-nn reproduce, not on XNNPACK's."""
    from ai_edge_litert.interpreter import Interpreter, OpResolverType

    return Interpreter(model_path=str(path),
                       experimental_op_resolver_type=OpResolverType.BUILTIN_REF)


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
    interpreter = reference_interpreter(model_path)
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
                if name not in inputs:
                    continue
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


class OnnxRunner:
    """The float graph, one sample at a time; outputs in the graph's order."""

    batched = False

    def __init__(self, path: Path) -> None:
        import onnxruntime as ort

        self.session = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])
        self.name = self.session.get_inputs()[0].name

    def __call__(self, x: np.ndarray) -> list[np.ndarray]:
        return self.session.run(None, {self.name: x.astype(np.float32)})


class TfliteRunner:
    """The TFLM file, outputs put back into the ONNX graph's order and NCHW layout."""

    batched = False

    def __init__(self, path: Path, shapes: list[tuple[int, ...]]) -> None:
        self.interpreter = reference_interpreter(path)
        self.interpreter.allocate_tensors()
        self.inp = self.interpreter.get_input_details()[0]
        self.outs = self.interpreter.get_output_details()
        nchw = [tuple(int(v) for v in d["shape"][[0, 3, 1, 2]]) if len(d["shape"]) == 4
                else tuple(int(v) for v in d["shape"]) for d in self.outs]
        # The converter lists heads in its own order; the shapes pair them back up.
        self.order = [nchw.index(tuple(s)) for s in shapes]

    def __call__(self, x: np.ndarray) -> list[np.ndarray]:
        nhwc = x.transpose(0, 2, 3, 1) if x.ndim == 4 else x
        self.interpreter.set_tensor(self.inp["index"], quantized(nhwc, self.inp))
        self.interpreter.invoke()
        got = []
        for detail in self.outs:
            value = dequantized(self.interpreter.get_tensor(detail["index"]), detail)
            got.append(value.transpose(0, 3, 1, 2) if value.ndim == 4 else value)
        return [got[i] for i in self.order]


def run_batch(run, x: np.ndarray, chunk: int = 64) -> list[np.ndarray]:
    """Every output over a batch, stacked; a runner without a batch path goes one by one."""
    step = chunk if run.batched else 1
    parts = [run(np.ascontiguousarray(x[i : i + step])) for i in range(0, len(x), step)]
    return [np.concatenate([p[j] for p in parts]) for j in range(len(parts[0]))]


def espdl_runner(model: Path, run: Path, samples: int):
    """Quantise the run again as 30_quantize.sh did, refusing unless it carries model's weights."""
    from facepipe.compress.quant import ptq_espdl
    from facepipe.export.espdl_op_check import content_digest

    with tempfile.TemporaryDirectory() as work:
        folded = ptq_espdl.export_onnx(run, Path(work) / "folded.onnx")
        check = Path(work) / "check.espdl"
        graph = ptq_espdl.quantize(folded, ptq_espdl.calibration(run, samples), check)
        if content_digest(check) != content_digest(model):
            raise SystemExit(f"{model.name}: its weights are not what {run.name} quantises to")
    return ptq_espdl.Simulator(graph)


def branch_eval(run: Path):
    from facepipe.core.config import load_run_config
    from facepipe.export.tf_to_tflite_int8 import BRANCH_PACKAGE

    package = BRANCH_PACKAGE[load_run_config(run).model.name]
    return package.rsplit(".", 1)[-1], importlib.import_module(f"{package}.eval")


def output_shapes(run: Path) -> list[tuple[int, ...]]:
    """The ONNX graph's output shapes, from the module export_spec traces."""
    import torch

    _branch, evaluator = branch_eval(run)
    _cfg, traced, example, _ins, _outs = evaluator.export_spec(run)
    with torch.no_grad():
        out = traced(*example)
    return [tuple(t.shape) for t in (out if isinstance(out, (tuple, list)) else (out,))]


def build_runner(runtime: str, model: Path, run: Path, samples: int):
    if runtime == "onnx":
        return OnnxRunner(model)
    if runtime == "espdl":
        return espdl_runner(model, run, samples)
    return TfliteRunner(model, output_shapes(run))


def data_path(entry: str) -> Path:
    """One dataset root from configs/common/paths.yaml, resolved against ml/."""
    import yaml

    node = yaml.safe_load((ML_ROOT / "configs/common/paths.yaml").read_text(encoding="utf-8"))
    for key in entry.split("."):
        node = node[key]
    return ML_ROOT / node


def firmware_constant(relative: str, pattern: re.Pattern) -> float:
    """A number the firmware declares, read from its source rather than copied."""
    from facepipe.export.tflite_op_check import repo_root

    found = pattern.search((repo_root(ML_ROOT) / relative).read_text(encoding="utf-8"))
    if found is None:
        raise SystemExit(f"{relative}: the constant this score depends on is gone")
    return float(found.group(1))


def score_detection(run, cfg) -> str:
    import torch

    from facepipe.tasks.detection.eval import (
        SERVICE_FACE_PX,
        SETTINGS,
        evaluate,
        load_ground_truth,
        predict_images,
        size_subset,
    )
    from facepipe.tasks.detection.model.head import HeadOutput

    class AsHead:
        def eval(self):
            return self

        def __call__(self, tensor: torch.Tensor) -> HeadOutput:
            outs = [torch.from_numpy(o) for o in run(tensor.cpu().numpy())]
            return HeadOutput(cls=outs[0:3], bbox=outs[3:6], kps=outs[6:9])

    wider = data_path("detection.widerface")
    input_hw = tuple(int(v) for v in cfg.model.input_hw)
    truth = load_ground_truth(wider / "eval_tools/ground_truth")
    images = wider / "WIDER_val/images"
    served = f"ge{SERVICE_FACE_PX:g}px"
    truth.keep[served] = size_subset(truth, images, input_hw, SERVICE_FACE_PX)
    found = predict_images(AsHead(), truth.names, images, input_hw, torch.device("cpu"))
    ap = evaluate({n: d.xywh_with_score() for n, d in found.items()}, truth, (*SETTINGS, served))
    return "  ".join(f"{key} AP {ap[key]:.4f}" for key in (*SETTINGS, served))


def live_scores(logits: np.ndarray, live_index: int) -> np.ndarray:
    z = logits - logits.max(axis=1, keepdims=True)
    e = np.exp(z)
    return e[:, live_index] / e.sum(axis=1)


def score_device_frames(run, cfg, frames: Path) -> tuple[np.ndarray, np.ndarray]:
    """Liveness on the board's own frames, cut the way preproc.cpp cuts them."""
    import torch
    from PIL import Image

    from facepipe.tasks.antispoof.eval import largest_face, load_detector
    from facepipe.tasks.antispoof.losses.task_loss import LIVE
    from facepipe.tasks.antispoof.postproc.preproc import fitted_square, resample_square

    raw = data_path("device.ov5640")
    size = int(cfg.model.input_hw[0])
    face_scale = firmware_constant(PREPROC_CPP, _FACE_SCALE)
    detector, priors = load_detector(data_path("antispoof.detector"), torch.device("cpu"))
    crops, labels = [], []
    for line in frames.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        name, label = line.split()
        with Image.open(raw / name) as handle:
            rgb = np.array(handle.convert("RGB"), dtype=np.uint8)
        box = largest_face(detector, priors, rgb, torch.device("cpu"))
        if box is None:
            continue
        left, top, side = fitted_square(box, face_scale, rgb.shape[1], rgb.shape[0])
        crops.append(resample_square(rgb, left, top, side, size))
        labels.append(int(label))
    x = (np.stack(crops).astype(np.float32) / 255.0).transpose(0, 3, 1, 2)
    return live_scores(run_batch(run, x)[0], LIVE), np.array(labels)


def score_split(run, cfg, split: str, input_name: str) -> tuple[np.ndarray, np.ndarray]:
    from facepipe.tasks.antispoof.eval import build_loader
    from facepipe.tasks.antispoof.losses.task_loss import LIVE

    got, truth = [], []
    for tight, wide, labels, *_rest in build_loader(cfg, split):
        view = wide if input_name == "wide" else tight
        got.extend(live_scores(run_batch(run, view.numpy().astype(np.float32))[0], LIVE))
        truth.extend(int(v) for v in labels.numpy())
    return np.array(got), np.array(truth)


def score_antispoof(run, run_dir: Path, cfg, split: str | None, frames: Path | None) -> str:
    from facepipe.tasks.antispoof.eval import auc, equal_error_rate
    from facepipe.tasks.antispoof.losses.task_loss import LIVE

    if frames is not None:
        live, truth = score_device_frames(run, cfg, frames)
    else:
        input_name = branch_eval(run_dir)[1].export_spec(run_dir)[3][0]
        live, truth = score_split(run, cfg, split or cfg.data.params["test_split"], input_name)
    floor = firmware_constant(VISION_KCONFIG, _LIVE_MIN) / 1000.0
    real, fake = live[truth == LIVE], live[truth != LIVE]
    eer = equal_error_rate(live, truth).acer
    line = f"n={live.size}  auc {auc(live, truth):.4f}  eer {eer:.4f}"
    return (f"{line}  at live_min {floor:.3f}: real kept {int((real >= floor).sum())}/{real.size}"
            f"  attacks blocked {int((fake < floor).sum())}/{fake.size}"
            f"  real min {real.min():.3f}  attack max {fake.max():.3f}")


def score_recognition(run, cfg) -> str:
    from facepipe.tasks.recognition.eval import (
        BENCHMARKS,
        decode_images,
        evaluate_pairs,
        pair_scores,
        read_bin,
    )

    root = ML_ROOT / cfg.data.params["benchmarks"]
    size = int(cfg.model.input_hw[0])
    cells = []
    for name in BENCHMARKS:
        if not (root / f"{name}.bin").is_file():
            continue
        encoded, issame = read_bin(root / f"{name}.bin")
        images = decode_images(encoded, size)
        x = ((images.astype(np.float32) - 127.5) / 127.5).transpose(0, 3, 1, 2)
        vectors = run_batch(run, x, chunk=32)[0].reshape(len(x), -1)
        vectors /= np.maximum(np.linalg.norm(vectors, axis=1, keepdims=True), 1e-10)
        result = evaluate_pairs(pair_scores(vectors), issame)
        cells.append(f"{name} {result['accuracy']:.4f} / {result['tar@far0.001']:.3f}"
                     f" / {result['tar@far0.0001']:.3f}")
    return "  ".join(cells) + "  (acc / TAR@1e-3 / TAR@1e-4)"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, required=True, help=".onnx, .tflite or .espdl")
    parser.add_argument("--run", type=Path, required=True, help="run whose split and config apply")
    parser.add_argument("--runtime", choices=("tflite", "onnx", "espdl"), default="tflite")
    parser.add_argument("--split", default=None)
    parser.add_argument("--device-frames", nargs="?", type=Path, const=ML_ROOT / DEVICE_FRAMES,
                        default=None, help="score anti-spoof on the board's labelled frames")
    parser.add_argument("--limit", type=int, default=0,
                        help="anti-spoof .tflite on a split only; 0 scores the whole split")
    parser.add_argument("--samples", type=int, default=300, help="calibration size of the rung")
    args = parser.parse_args(argv)

    from facepipe.core.config import load_run_config

    cfg = load_run_config(args.run)
    branch, _evaluator = branch_eval(args.run)
    if branch == "antispoof" and args.runtime == "tflite" and args.device_frames is None:
        from facepipe.tasks.antispoof.eval import auc, build_loader, equal_error_rate
        from facepipe.tasks.antispoof.losses.task_loss import LIVE

        split = args.split or cfg.data.params["test_split"]
        live, truth = scores(args.model, build_loader(cfg, split), LIVE, args.limit)
        crossing = equal_error_rate(live, truth)
        area = auc(live, truth)
        print(
            f"{args.model.name}  n={live.size}  auc {area:.4f}  eer {crossing.acer:.4f}"
            f"  threshold {crossing.threshold:.6f}"
        )
        return 0

    run = build_runner(args.runtime, args.model, args.run, args.samples)
    if branch == "detection":
        line = score_detection(run, cfg)
    elif branch == "antispoof":
        line = score_antispoof(run, args.run, cfg, args.split, args.device_frames)
    else:
        line = score_recognition(run, cfg)
    print(f"{args.model.name}  {args.runtime}  {line}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
