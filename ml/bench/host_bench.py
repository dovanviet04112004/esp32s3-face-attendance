"""Score a model on the host with its branch's own metric, so a rung compares to the Q0 ceiling.

Three runtimes: onnx (the float graph), tflite (the file TFLM runs) and espdl (the ESP-PPQ
simulation of a ladder row, which model->test() holds to the chip bit for bit). Each branch scores
with the ruler of its tasks/<branch>/quant.py, and anti-spoof also on a split (KEHOACH 3.7).
"""

import argparse
import sys
import tempfile
from pathlib import Path

import numpy as np

ML_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ML_ROOT / "src"))


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

    return Interpreter(
        model_path=str(path), experimental_op_resolver_type=OpResolverType.BUILTIN_REF
    )


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
    from facepipe.tasks.antispoof.quant import live_scores

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
            logits = dequantized(interpreter.get_tensor(output["index"]), output)
            got.append(float(live_scores(logits, live_index)[0]))
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
        nchw = [
            tuple(int(v) for v in d["shape"][[0, 3, 1, 2]])
            if len(d["shape"]) == 4
            else tuple(int(v) for v in d["shape"])
            for d in self.outs
        ]
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


def espdl_runner(model: Path, run: Path):
    """The ladder row that wrote model, run under its patches; refused unless it holds model."""
    from facepipe.compress.quant import esp_ppq_patches, export_espdl, ladder, ptq_espdl
    from facepipe.export.espdl_op_check import content_digest

    native = model.with_name(ladder.GRAPH_FILE)
    if not native.is_file():
        raise SystemExit(f"{model}: no {native.name} beside it, so it is no ladder row's .espdl")
    graph = export_espdl.load_native(native)
    patches = ladder.row_patches(run, model.parent.name)
    test_input = ladder.real_inputs(run, graph, 1)
    with tempfile.TemporaryDirectory() as work, esp_ppq_patches.applied(patches):
        check = export_espdl.export(graph, Path(work) / model.name, test_input)
        if content_digest(check) != content_digest(model):
            raise SystemExit(f"{model.name}: its weights are not those of {native}")
    return ptq_espdl.Simulator(graph, patches)


def output_shapes(run: Path) -> list[tuple[int, ...]]:
    """The ONNX graph's output shapes, from the module export_spec traces."""
    import torch

    from facepipe import tasks

    _cfg, traced, example, _ins, _outs = tasks.module_of(run, "eval").export_spec(run)
    with torch.no_grad():
        out = traced(*example)
    return [tuple(t.shape) for t in (out if isinstance(out, tuple | list) else (out,))]


def build_runner(runtime: str, model: Path, run: Path):
    if runtime == "onnx":
        return OnnxRunner(model)
    if runtime == "espdl":
        return espdl_runner(model, run)
    return TfliteRunner(model, output_shapes(run))


def score_split(runner, run: Path, cfg, split: str) -> str:
    """Liveness on one anti-spoof split through the graph's own input, by the branch's ruler."""
    from facepipe import tasks
    from facepipe.compress.quant.ladder import run_batch
    from facepipe.tasks.antispoof import quant
    from facepipe.tasks.antispoof.eval import build_loader
    from facepipe.tasks.antispoof.losses.task_loss import LIVE

    input_name = tasks.module_of(run, "eval").export_spec(run)[3][0]
    got, truth = [], []
    for tight, wide, labels, *_rest in build_loader(cfg, split):
        view = wide if input_name == "wide" else tight
        got.extend(quant.live_scores(run_batch(runner, view.numpy().astype(np.float32))[0], LIVE))
        truth.extend(int(v) for v in labels.numpy())
    live = np.array(got)
    return f"n={live.size}  " + quant.headline(quant.metrics_of(live, np.array(truth)))


FLOOR_BENCHMARKS = ("lfw", "cfp_ff", "calfw", "cfp_fp", "agedb_30", "cplfw")
FLOORS = (0.30, 0.35, 0.40, 0.45, 0.50, 0.60)


def locked_espdl(run: Path) -> Path:
    """The ladder row's .espdl that contracts/models.lock.json deploys, found by its sha256."""
    import hashlib
    import json

    from facepipe import REPO_ROOT, tasks

    lock = json.loads((REPO_ROOT / "contracts" / "models.lock.json").read_text(encoding="utf-8"))
    want = lock[tasks.branch_of(run)]["sha256"]
    for path in sorted(run.glob("int8/*/*.espdl")):
        if hashlib.sha256(path.read_bytes()).hexdigest() == want:
            return path
    raise SystemExit(f"{run}: no ladder row holds the .espdl the lock deploys")


def floor_table(runner, cfg, top: int) -> str:
    """The evidence for vision.match_min: how high strangers score, and what each floor keeps.

    Every pair of six verification benchmarks, unflipped, as the kiosk compares (KEHOACH 4.5.5d).
    """
    from facepipe import ML_ROOT
    from facepipe.tasks.recognition.eval import pair_scores, read_bin
    from facepipe.tasks.recognition.quant import embeddings

    root = ML_ROOT / cfg.data.params["benchmarks"]
    size = int(cfg.model.input_hw[0])
    found: dict[str, tuple[np.ndarray, np.ndarray]] = {}
    for name in FLOOR_BENCHMARKS:
        if (root / f"{name}.bin").is_file():
            encoded, issame = read_bin(root / f"{name}.bin")
            vectors = embeddings(runner, encoded, size)
            vectors /= np.maximum(np.linalg.norm(vectors, axis=1, keepdims=True), 1e-10)
            found[name] = (pair_scores(vectors), issame)
    lines = ["benchmark  strangers  mean    std     highest  same-person mean"]
    for name, (score, same) in found.items():
        other = score[~same]
        lines.append(
            f"{name:9s}  {other.size:9d}  {other.mean():.3f}   {other.std():.3f}"
            f"   {other.max():.3f}    {score[same].mean():.3f}"
        )
    ranked = sorted(
        (
            (float(s), name, int(i))
            for name, (score, same) in found.items()
            for i, s in enumerate(score)
            if not same[i]
        ),
        reverse=True,
    )[:top]
    lines.append("highest strangers: " + "  ".join(f"{name}#{i} {s:.3f}" for s, name, i in ranked))
    lines.append("floor  strangers over  same person kept: " + " · ".join(found))
    for floor in FLOORS:
        over = sum(int((score[~same] >= floor).sum()) for score, same in found.values())
        kept = " · ".join(f"{(score[same] >= floor).mean():.3f}" for score, same in found.values())
        lines.append(f"{floor:.2f}   {over:14d}  {kept}")
    return "\n".join(lines)


DETECT_FLOORS = (0.25, 0.30, 0.35, 0.40, 0.45, 0.50)
FACE_IOU = 0.5
# Boxes overlapping the face less than this are something else the frame holds.
APART_IOU = 0.3


def detect_floor_table(runner, run: Path, cfg) -> str:
    """The evidence for vision.detect_min: the face each kiosk frame holds, and the rest it scores.

    Every OV5640 frame of test_device; the face is where the float detector the anti-spoof eval
    cuts with finds it, and the locked detector's boxes are scored against that place.
    """
    import torch

    from facepipe.compress.quant.ladder import data_path, device_frames, hooks_of
    from facepipe.tasks.antispoof.eval import largest_detection, load_detector
    from facepipe.tasks.detection.data import letterbox_params
    from facepipe.tasks.detection.eval import decode_batch, iou_xyxy, to_original
    from facepipe.tasks.detection.model.anchors import feature_sizes, pyramid_priors
    from facepipe.tasks.detection.model.head import HeadOutput
    from facepipe.tasks.detection.model.yunet import STRIDES

    cpu = torch.device("cpu")
    reference, reference_priors = load_detector(data_path("antispoof.detector"), cpu)
    frames = device_frames()
    inputs = hooks_of(run).probe_inputs(cfg, frames, len(frames))
    input_hw = tuple(int(v) for v in cfg.model.input_hw)
    priors = torch.cat(pyramid_priors(feature_sizes(input_hw, STRIDES), STRIDES))
    faces, rest, faceless = [], [], 0
    for (_name, _label, rgb), x in zip(frames, inputs, strict=True):
        truth = largest_detection(reference, reference_priors, rgb, cpu)
        if truth is None:
            faceless += 1
            continue
        outs = [torch.from_numpy(o) for o in runner(np.ascontiguousarray(x[None]))]
        found = decode_batch(HeadOutput(cls=outs[0:3], bbox=outs[3:6], kps=outs[6:9]), priors)[0]
        mapped = to_original(found, *letterbox_params(rgb.shape[:2], input_hw))
        overlap = iou_xyxy(mapped.boxes, truth[0]) if mapped.scores.size else np.zeros(0)
        on, apart = overlap >= FACE_IOU, overlap < APART_IOU
        faces.append(float(mapped.scores[on].max()) if on.any() else 0.0)
        rest.append(float(mapped.scores[apart].max()) if apart.any() else 0.0)
    face, other = np.array(faces), np.array(rest)
    lines = [
        f"frames {face.size} with a face, {faceless} without one the reference finds",
        f"face: min {face.min():.3f}  median {np.median(face):.3f}  max {face.max():.3f}",
        f"everything else: highest {other.max():.3f}"
        f"  median of each frame's highest {np.median(other):.3f}",
        "floor  faces kept  frames scoring something else over",
    ]
    for floor in DETECT_FLOORS:
        lines.append(
            f"{floor:.2f}   {int((face >= floor).sum()):10d}  {int((other >= floor).sum()):d}"
        )
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--model", type=Path, help=".onnx, .tflite or .espdl; --floors finds the locked one"
    )
    parser.add_argument("--run", type=Path, required=True, help="run whose split and config apply")
    parser.add_argument(
        "--floors",
        action="store_true",
        help="recognition: what each match_min floor keeps; detection: the same for detect_min",
    )
    parser.add_argument(
        "--top", type=int, default=8, help="--floors: how many highest strangers to name"
    )
    parser.add_argument("--runtime", choices=("tflite", "onnx", "espdl"), default="tflite")
    parser.add_argument("--split", default=None, help="anti-spoof: score this split")
    parser.add_argument(
        "--device-frames",
        action="store_true",
        help="anti-spoof: score the board's labelled frames, as the ladder does",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=0,
        help="anti-spoof .tflite on a split only; 0 scores the whole split",
    )
    args = parser.parse_args(argv)

    from facepipe import tasks
    from facepipe.compress.quant import ladder

    run = args.run.resolve()
    cfg = ladder.config_of(run)
    branch = tasks.branch_of(run)
    if args.floors:
        if branch not in ("recognition", "detection"):
            raise SystemExit(
                "--floors measures the recognition or detection floor; this run is " + branch
            )
        model = args.model or locked_espdl(run)
        runner = espdl_runner(model, run)
        table = (
            floor_table(runner, cfg, args.top)
            if branch == "recognition"
            else detect_floor_table(runner, run, cfg)
        )
        print(f"{model}\n{table}")
        return 0
    if args.model is None:
        raise SystemExit("--model is needed unless --floors finds the locked one")
    on_split = branch == "antispoof" and not args.device_frames
    split = args.split or (cfg.data.params["test_split"] if on_split else None)
    if on_split and args.runtime == "tflite":
        from facepipe.tasks.antispoof.eval import auc, build_loader, equal_error_rate
        from facepipe.tasks.antispoof.losses.task_loss import LIVE

        live, truth = scores(args.model, build_loader(cfg, split), LIVE, args.limit)
        crossing = equal_error_rate(live, truth)
        area = auc(live, truth)
        print(
            f"{args.model.name}  n={live.size}  auc {area:.4f}  eer {crossing.acer:.4f}"
            f"  threshold {crossing.threshold:.6f}"
        )
        return 0

    runner = build_runner(args.runtime, args.model, run)
    if on_split:
        line = score_split(runner, run, cfg, split)
    else:
        hooks = ladder.hooks_of(run)
        line = hooks.headline(hooks.score(runner, cfg))
    print(f"{args.model.name}  {args.runtime}  {line}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
