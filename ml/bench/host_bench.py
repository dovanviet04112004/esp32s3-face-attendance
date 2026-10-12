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
    """The ladder row that wrote model, simulated; refused unless it holds model's weights."""
    from facepipe import tasks
    from facepipe.compress.quant import export_espdl, ladder, ptq_espdl
    from facepipe.export.espdl_op_check import content_digest

    native = model.with_name(ladder.GRAPH_FILE)
    if not native.is_file():
        raise SystemExit(f"{model}: no {native.name} beside it, so it is no ladder row's .espdl")
    graph = export_espdl.load_native(native)
    patches = ptq_espdl.block(tasks.branch_of(run))["esp_ppq_patches"]
    test_input = ladder.real_inputs(run, graph, 1)
    with tempfile.TemporaryDirectory() as work:
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


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", type=Path, required=True, help=".onnx, .tflite or .espdl")
    parser.add_argument("--run", type=Path, required=True, help="run whose split and config apply")
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
