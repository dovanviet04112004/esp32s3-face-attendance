"""KEHOACH 3.7: a branch's ESP-PPQ patches enter in order, leave in reverse, and all exist."""

from __future__ import annotations

import contextlib
import math
from pathlib import Path

import numpy as np
import pytest
import torch
from torch import nn

from facepipe import REPO_ROOT
from facepipe.compress.quant import esp_ppq_patches, espdl_shapes, export_espdl, ladder, ptq_espdl
from facepipe.export import espdl_op_check
from tests.conftest import quantise_ladder_net


def recording(name: str, seen: list[str]):
    @contextlib.contextmanager
    def patch():
        seen.append(f"+{name}")
        try:
            yield
        finally:
            seen.append(f"-{name}")

    return patch


def test_patches_enter_in_order_and_leave_in_reverse(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[str] = []
    monkeypatch.setattr(
        esp_ppq_patches, "PATCHES", {"a": recording("a", seen), "b": recording("b", seen)}
    )
    with esp_ppq_patches.applied(["b", "a"]):
        seen.append("body")
    assert seen == ["+b", "+a", "body", "-a", "-b"]


def test_a_patch_leaves_even_when_the_body_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[str] = []
    monkeypatch.setattr(esp_ppq_patches, "PATCHES", {"a": recording("a", seen)})
    with pytest.raises(RuntimeError), esp_ppq_patches.applied(["a"]):
        raise RuntimeError
    assert seen == ["+a", "-a"]


def test_an_unknown_patch_is_refused_before_any_enters(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[str] = []
    monkeypatch.setattr(esp_ppq_patches, "PATCHES", {"a": recording("a", seen)})
    with (
        pytest.raises(ValueError, match="no ESP-PPQ patch named"),
        esp_ppq_patches.applied(["a", "missing"]),
    ):
        pass
    assert seen == []


def test_no_patch_at_all_changes_nothing() -> None:
    with esp_ppq_patches.applied([]):
        pass


def test_every_branch_names_only_patches_that_exist() -> None:
    for branch in ("detection", "antispoof", "recognition"):
        knobs = ptq_espdl.block(branch)
        assert set(knobs["esp_ppq_patches"]) <= set(esp_ppq_patches.PATCHES), branch
        assert set(knobs["rounding_patches"]) <= esp_ppq_patches.ROUNDING, branch


def test_a_patch_that_changes_integers_is_refused_for_every_row(monkeypatch) -> None:
    knobs = {"esp_ppq_patches": ["fused_prelu"], "rounding_patches": []}
    monkeypatch.setattr(ptq_espdl, "load_ladder", lambda: {"branches": {"antispoof": knobs}})
    with pytest.raises(ValueError, match="rounding_patches"):
        ptq_espdl.block("antispoof")


def espdl_graph(path: Path) -> tuple[dict, dict, dict]:
    """An .espdl's nodes by name as (op, inputs, outputs), its initializers and their exponents."""
    import flatbuffers

    graph = espdl_op_check.graph(path)
    nodes = {}
    for i in range(graph.NodeLength()):
        node = graph.Node(i)
        inputs = [node.Input(j).decode() for j in range(node.InputLength())]
        outputs = [node.Output(j).decode() for j in range(node.OutputLength())]
        nodes[node.Name().decode()] = (node.OpType().decode(), inputs, outputs)
    dtypes, tensors, exponents = {1: np.float32, 3: np.int8, 6: np.int32, 7: np.int64}, {}, {}
    for i in range(graph.InitializerLength()):
        t = graph.Initializer(i)
        dims = [int(d) for d in t.DimsAsNumpy()]
        start = t._tab.Vector(flatbuffers.number_types.UOffsetTFlags.py_type(t._tab.Offset(20)))
        raw = bytes(t._tab.Bytes[start : start + 16 * t.RawDataLength()])
        data = np.frombuffer(raw, dtypes[t.DataType()])[: math.prod(dims)]
        tensors[t.Name().decode()] = data.reshape(dims)
        exponents[t.Name().decode()] = [int(e) for e in t.ExponentsAsNumpy()]
    return nodes, tensors, exponents


def filters(stored: np.ndarray) -> np.ndarray:
    """A pointwise convolution's (outputs, inputs) weights from ESP-PPQ's S3 layout of them.

    ResetParamLayoutPattern interleaves each 16 outputs innermost and leaves the rest as they are.
    """
    n = stored.shape[-1]
    flat, aligned = stored.reshape(-1), n // 16 * 16
    per = flat.size // n
    head = flat[: aligned * per].reshape(n // 16, per, 16).transpose(0, 2, 1).reshape(aligned, per)
    return np.concatenate([head, flat[aligned * per :].reshape(n - aligned, per)])


class WideExpansion(nn.Module):
    """A 16 KB pointwise convolution, then a 128 -> 512 one whose 64 KB fill the S3's data cache."""

    def __init__(self) -> None:
        super().__init__()
        self.narrow = nn.Conv2d(128, 128, 1)
        self.expand = nn.Conv2d(128, 512, 1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.expand(torch.relu(self.narrow(x)))


def test_output_sizes_cut_whole_channel_steps_within_the_bound() -> None:
    assert esp_ppq_patches.output_sizes(512, 65536, 32768) == [256, 256]
    assert esp_ppq_patches.output_sizes(128, 65536, 32768) == [64, 64]
    assert esp_ppq_patches.output_sizes(100, 65536, 32768) == [100]
    assert esp_ppq_patches.output_sizes(128, 16384, 32768) == [128]


def test_cache_sized_convolutions_slice_only_what_fills_the_cache(tmp_path: Path) -> None:
    pytest.importorskip("esp_ppq")
    torch.manual_seed(5)
    calib = [torch.rand(1, 128, 4, 4) for _ in range(2)]
    rungs = ptq_espdl.timing_rungs("recognition")
    graph = quantise_ladder_net(WideExpansion().eval(), tmp_path, calib, rungs, ("out",))
    test_input = calib[0].numpy()
    plain = espdl_graph(export_espdl.export(graph, tmp_path / "plain.espdl", test_input))
    with esp_ppq_patches.applied(["cache_sized_convolutions"]):
        sliced = espdl_graph(export_espdl.export(graph, tmp_path / "sliced.espdl", test_input))
    assert [op for op, _, _ in sliced[0].values()].count("Concat") == 0
    narrow = sliced[0]["/narrow/Conv"]
    assert narrow[0] == "Conv"
    assert np.array_equal(sliced[1][narrow[1][1]], plain[1][plain[0]["/narrow/Conv"][1][1]])
    op, inputs, outputs = sliced[0]["/expand/Conv"]
    assert (op, outputs) == (espdl_shapes.SLICED_CONV, plain[0]["/expand/Conv"][2])
    weights, biases = inputs[1::2], inputs[2::2]
    assert [sliced[1][w].shape[-1] for w in weights] == [256, 256]
    whole = plain[0]["/expand/Conv"][1]
    assert np.array_equal(
        np.concatenate([filters(sliced[1][w]) for w in weights]), filters(plain[1][whole[1]])
    )
    assert np.array_equal(np.concatenate([sliced[1][b] for b in biases]), plain[1][whole[2]])


def test_the_export_hooks_are_put_back_after_the_patches() -> None:
    pytest.importorskip("esp_ppq")
    from esp_ppq.parser import espdl_exporter
    from esp_ppq.parser.espdl import export_patterns

    def hooks() -> list:
        return [
            espdl_exporter.reset_graph_layout,
            export_patterns.FuseReluLikePattern.export,
            espdl_exporter.EspdlExporter.export_graph,
        ]

    kept = hooks()
    with esp_ppq_patches.applied(["cache_sized_convolutions", "fused_prelu"]):
        assert all(now is not before for now, before in zip(hooks(), kept, strict=True))
    assert hooks() == kept


class SlopedConvolutions(nn.Module):
    """A pointwise and a depthwise convolution whose PReLUs keep their input's exponent.

    The third PReLU sees only large negatives its small slopes shrink to a finer exponent, and a
    last convolution feeds a Sigmoid, a reader with one input.
    """

    def __init__(self) -> None:
        super().__init__()
        self.pointwise = nn.Conv2d(16, 16, 1)
        self.depthwise = nn.Conv2d(16, 16, 3, padding=1, groups=16)
        self.shrinking = nn.Conv2d(16, 16, 1)
        self.gate = nn.Conv2d(16, 16, 1)
        self.slopes = nn.ModuleList(nn.PReLU(16) for _ in range(3))
        with torch.no_grad():
            for conv, spread, bias in (
                (self.pointwise, 0.1, 0.2),
                (self.depthwise, 0.2, 0.1),
                (self.shrinking, 0.1, -12.0),
            ):
                conv.weight.uniform_(-spread, spread)
                conv.bias.fill_(bias)
            for slope in self.slopes:
                slope.weight.uniform_(0.005, 0.3)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        convs = (self.pointwise, self.depthwise, self.shrinking)
        for conv, slope in zip(convs, self.slopes, strict=True):
            x = slope(conv(x))
        return torch.sigmoid(self.gate(x))


@pytest.fixture(scope="module")
def sloped(tmp_path_factory: pytest.TempPathFactory):
    """SlopedConvolutions quantised for the S3, its calibration, and its fusable PRelus."""
    pytest.importorskip("esp_ppq")
    torch.manual_seed(7)
    calib = [torch.rand(1, 16, 6, 6) for _ in range(4)]
    work = tmp_path_factory.mktemp("sloped")
    rungs = ptq_espdl.timing_rungs("antispoof")
    graph = quantise_ladder_net(SlopedConvolutions().eval(), work, calib, rungs, ("out",))
    fusable = [op for op in graph.operations.values() if esp_ppq_patches.fusable(op)]
    return graph, calib, fusable


def test_fused_prelu_simulates_the_s3_kernel_s_floor(sloped) -> None:
    from esp_ppq.executor import TorchExecutor
    from esp_ppq.quantization.qfunction.linear import PPQLinearQuant_toInt

    graph, calib, fusable = sloped
    executor = TorchExecutor(graph, device="cpu")
    names = [name for op in fusable for name in (op.inputs[0].name, op.outputs[0].name)]
    rounded = executor.forward(calib[0], output_names=names)
    with esp_ppq_patches.applied(["fused_prelu"]):
        floored = executor.forward(calib[0], output_names=names)
    differs = 0
    for i, op in enumerate(fusable):
        step = float(op.output_quant_config[0].scale)
        x = torch.round(floored[2 * i] / step).long()
        slope_config = op.input_quant_config[1]
        a = PPQLinearQuant_toInt(op.inputs[1].value, slope_config).long().reshape(1, -1, 1, 1)
        shift = -round(math.log2(float(slope_config.scale)))
        want = torch.where(x < 0, (x * a) >> shift, x).clamp(-128, 127)
        assert torch.equal(torch.round(floored[2 * i + 1] / step).long(), want)
        differs += int((rounded[2 * i + 1] != floored[2 * i + 1]).sum())
    assert differs > 0


def test_fused_prelu_joins_each_fusable_prelu_to_its_conv(sloped, tmp_path: Path) -> None:
    graph, calib, fusable = sloped
    kept = {op.inputs[0].source_op.name for op in fusable}
    (port, *_), _outputs = ptq_espdl.ports_of(graph)
    test_input = ladder.on_grid(calib[0].numpy(), port.exponent)
    plain = espdl_graph(export_espdl.export(graph, tmp_path / "plain.espdl", test_input))
    with esp_ppq_patches.applied(["fused_prelu"]):
        fused = espdl_graph(export_espdl.export(graph, tmp_path / "fused.espdl", test_input))
    assert kept == {"/pointwise/Conv", "/depthwise/Conv"}
    assert {n for n, (op, _, _) in fused[0].items() if op == espdl_shapes.FUSED_PRELU} == kept
    assert [op for op, _, _ in fused[0].values()].count("PRelu") == 1
    readers = {ins[0]: (ins[1], outs) for op, ins, outs in plain[0].values() if op == "PRelu"}
    for name in kept:
        _op, inputs, (y,) = plain[0][name]
        slope, outputs = readers[y]
        assert fused[0][name] == (espdl_shapes.FUSED_PRELU, [*inputs, slope], outputs)
        for param in (*inputs[1:], slope):
            assert np.array_equal(fused[1][param].reshape(-1), plain[1][param].reshape(-1))
            assert fused[2][param] == plain[2][param]
        assert fused[1][slope].shape == (16,)


class NarrowBlocks(nn.Module):
    """Two residual blocks whose middle widths, 13 and 26, are not multiples of 16, and a 10-channel
    head whose output leaves the graph."""

    def __init__(self) -> None:
        super().__init__()
        self.stem = nn.Conv2d(3, 16, 3, padding=1)
        self.blocks = nn.ModuleList(
            nn.Sequential(
                nn.Conv2d(16, mid, 1),
                nn.PReLU(mid),
                nn.Conv2d(mid, mid, 3, padding=1, groups=mid),
                nn.PReLU(mid),
                nn.Conv2d(mid, 16, 1),
            )
            for mid in (13, 26)
        )
        self.head = nn.Conv2d(16, 10, 1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = self.stem(x)
        for block in self.blocks:
            x = x + block(x)
        return self.head(x)


def test_padded_channels_grows_a_block_with_zeros_and_changes_no_integer(tmp_path: Path) -> None:
    pytest.importorskip("esp_ppq")
    torch.manual_seed(11)
    calib = [torch.rand(1, 3, 8, 8) for _ in range(4)]
    rungs = ptq_espdl.timing_rungs("antispoof")
    graph = quantise_ladder_net(NarrowBlocks().eval(), tmp_path, calib, rungs, ("out",))
    (port, *_), _outputs = ptq_espdl.ports_of(graph)
    test_input = ladder.on_grid(calib[0].numpy(), port.exponent)
    plain = espdl_graph(export_espdl.export(graph, tmp_path / "plain.espdl", test_input))
    with esp_ppq_patches.applied(["padded_channels"]):
        grown = espdl_graph(export_espdl.export(graph, tmp_path / "grown.espdl", test_input))
    assert plain[0].keys() == grown[0].keys()
    widths = {}
    for name, (_op, inputs, _outputs) in plain[0].items():
        for param in inputs[1:]:
            if param not in plain[1]:
                continue
            before, after = plain[1][param], grown[1][param]
            assert grown[2][param] == plain[2][param], param
            assert np.array_equal(np.sort(after[after != 0]), np.sort(before[before != 0])), param
            widths[name] = (before.size, after.size)
    expand, depthwise = "/blocks.0/blocks.0.0/Conv", "/blocks.0/blocks.0.2/Conv"
    project, head = "/blocks.0/blocks.0.4/Conv", "/head/Conv"
    assert np.array_equal(
        filters(grown[1][grown[0][expand][1][1]])[:13], filters(plain[1][plain[0][expand][1][1]])
    )
    assert not filters(grown[1][grown[0][expand][1][1]])[13:].any()
    assert widths[depthwise][1] > widths[depthwise][0]
    assert not filters(grown[1][grown[0][project][1][1]])[:, 13:].any()
    assert widths[head][0] == widths[head][1]
    assert np.array_equal(grown[1][grown[0][head][1][1]], plain[1][plain[0][head][1][1]])


def test_a_clip_keeps_zero_only_when_zero_lies_inside_its_bounds() -> None:
    from types import SimpleNamespace

    def clip(low: float, high: float):
        bound = [SimpleNamespace(is_parameter=True, value=torch.tensor(v)) for v in (low, high)]
        return SimpleNamespace(type="Clip", inputs=[None, *bound])

    assert esp_ppq_patches.keeps_zero(clip(0.0, 6.0))
    assert not esp_ppq_patches.keeps_zero(clip(1.0, 6.0))
    assert esp_ppq_patches.keeps_zero(SimpleNamespace(type="PRelu", inputs=[]))
    assert not esp_ppq_patches.keeps_zero(SimpleNamespace(type="Sigmoid", inputs=[]))


class BoundedConvolutions(nn.Module):
    """Two convolutions each read by a ReLU6, biased so a share of the first one's values pass 6."""

    def __init__(self) -> None:
        super().__init__()
        self.first = nn.Conv2d(16, 16, 1)
        self.second = nn.Conv2d(16, 16, 3, padding=1, groups=16)
        with torch.no_grad():
            self.first.weight.uniform_(0.0, 0.8)
            self.first.bias.fill_(2.0)
            self.second.weight.uniform_(-0.1, 0.1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return nn.functional.relu6(self.second(nn.functional.relu6(self.first(x))))


def test_clip_as_relu_lifts_the_bound_and_exports_a_fused_relu(tmp_path: Path) -> None:
    pytest.importorskip("esp_ppq")
    from esp_ppq.executor import TorchExecutor

    torch.manual_seed(13)
    calib = [torch.rand(1, 16, 6, 6) for _ in range(4)]
    rungs = ptq_espdl.timing_rungs("detection")
    graph = quantise_ladder_net(BoundedConvolutions().eval(), tmp_path, calib, rungs, ("out",))
    ready = [op for op in graph.operations.values() if esp_ppq_patches.relu_ready(op)]
    assert len(ready) == 2
    names = [op.outputs[0].name for op in ready]
    executor = TorchExecutor(graph, device="cpu")
    bounded = executor.forward(calib[0], output_names=names)
    with esp_ppq_patches.applied(["clip_as_relu"]):
        lifted = executor.forward(calib[0], output_names=names)
    first, step = ready[0], float(ready[0].output_quant_config[0].scale)
    low, high = esp_ppq_patches.clip_bounds(first)
    top = torch.round(lifted[0] / step)
    assert (low, high) == (0.0, 6.0) and 127 * step > high
    assert torch.equal(torch.round(bounded[0] / step), top.clamp(max=round(high / step)))
    assert top.max() > round(high / step)
    (port, *_), _outputs = ptq_espdl.ports_of(graph)
    test_input = ladder.on_grid(calib[0].numpy(), port.exponent)
    plain = espdl_graph(export_espdl.export(graph, tmp_path / "plain.espdl", test_input))
    with esp_ppq_patches.applied(["clip_as_relu"]):
        fused = espdl_graph(export_espdl.export(graph, tmp_path / "fused.espdl", test_input))
    assert [op for op, _, _ in plain[0].values()].count("Clip") == 2
    assert sorted(op for op, _, _ in fused[0].values()) == ["Conv", "Conv"]


def test_a_prelu_moved_onto_its_conv_s_grid_fuses_and_its_reader_s_bias_follows(
    tmp_path: Path,
) -> None:
    pytest.importorskip("esp_ppq")
    from esp_ppq.core import QuantizationStates

    torch.manual_seed(7)
    calib = [torch.rand(1, 16, 6, 6) for _ in range(4)]
    rungs = ptq_espdl.timing_rungs("antispoof")
    graph = quantise_ladder_net(SlopedConvolutions().eval(), tmp_path, calib, rungs, ("out",))
    joinable = [op for op in graph.operations.values() if esp_ppq_patches.joinable(op)]
    apart = [op for op in joinable if not esp_ppq_patches.fusable(op)]
    assert len(apart) == 1
    gate = apart[0].outputs[0].dest_ops[0]
    assert esp_ppq_patches.share_prelu_grids(graph) == 1
    assert esp_ppq_patches.fusable(apart[0])
    x, w, b = gate.input_quant_config
    assert b.state == QuantizationStates.PASSIVE
    assert torch.equal(b.scale, w.scale * x.scale)
    assert esp_ppq_patches.share_prelu_grids(graph) == 0


def test_a_patch_stacked_before_the_one_it_needs_is_refused(monkeypatch) -> None:
    knobs = {"esp_ppq_patches": [], "rounding_patches": ["prelu_on_input_grid", "fused_prelu"]}
    monkeypatch.setattr(ptq_espdl, "load_ladder", lambda: {"branches": {"recognition": knobs}})
    with pytest.raises(ValueError, match="list fused_prelu before it"):
        ptq_espdl.block("recognition")


class EcaGate(nn.Module):
    """A convolution gated by ECA as MobileFaceNet-ECA has it: pooled, convolved across channels."""

    def __init__(self) -> None:
        super().__init__()
        self.conv = nn.Conv2d(3, 16, 3, padding=1)
        self.eca = nn.Conv1d(1, 1, 3, padding=1, bias=False)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        y = self.conv(x)
        w = nn.functional.adaptive_avg_pool2d(y, 1)
        w = self.eca(w.squeeze(-1).transpose(-1, -2)).transpose(-1, -2).unsqueeze(-1)
        return y * torch.sigmoid(w)


def channel_conv_reference(x: np.ndarray, w: np.ndarray, shift: int, pad: int) -> np.ndarray:
    """ChannelConv's integers: a zero-padded correlation along the channels, rounded half up."""
    padded = np.concatenate([np.zeros(pad, np.int64), x.astype(np.int64), np.zeros(pad, np.int64)])
    acc = np.array([padded[c : c + len(w)] @ w.astype(np.int64) for c in range(len(x))])
    rounded = (acc + (1 << (shift - 1))) >> shift if shift > 0 else acc << -shift
    return np.clip(rounded, -128, 127)


def test_channel_conv_replaces_the_eca_chain_with_its_own_integers(tmp_path: Path) -> None:
    pytest.importorskip("esp_ppq")
    from esp_ppq.executor import TorchExecutor
    from esp_ppq.quantization.qfunction.linear import PPQLinearQuant_toInt

    torch.manual_seed(17)
    calib = [torch.rand(1, 3, 8, 8) for _ in range(4)]
    rungs = ptq_espdl.timing_rungs("recognition")
    graph = quantise_ladder_net(EcaGate().eval(), tmp_path, calib, rungs, ("out",))
    conv = next(op for op in graph.operations.values() if esp_ppq_patches.eca_chain(graph, op))
    pooled, out = conv.inputs[0].source_op.inputs[0].source_op.inputs[0], conv.outputs[0]
    executor = TorchExecutor(graph, device="cpu")
    for sample in calib:
        x, y = executor.forward(sample, output_names=[pooled.name, out.name])
        steps = [float(c.scale) for c in (conv.input_quant_config[0], conv.output_quant_config[0])]
        w_config = conv.input_quant_config[1]
        w = PPQLinearQuant_toInt(conv.inputs[1].value, w_config).flatten().numpy()
        shift = round(math.log2(steps[1] / steps[0] / float(w_config.scale)))
        x_int = torch.round(x / steps[0]).flatten().numpy()
        want = channel_conv_reference(x_int, w, shift, conv.attributes["pads"][0])
        assert np.array_equal(torch.round(y / steps[1]).flatten().numpy(), want)
    (port, *_), _outputs = ptq_espdl.ports_of(graph)
    test_input = ladder.on_grid(calib[0].numpy(), port.exponent)
    plain = espdl_graph(export_espdl.export(graph, tmp_path / "plain.espdl", test_input))
    with esp_ppq_patches.applied(["channel_conv"]):
        joined = espdl_graph(export_espdl.export(graph, tmp_path / "joined.espdl", test_input))
    gone = {"Squeeze", "Unsqueeze", "Transpose"}
    assert gone <= {op for op, _, _ in plain[0].values()}
    assert not gone & {op for op, _, _ in joined[0].values()}
    ((_op, inputs, _),) = [n for n in joined[0].values() if n[0] == espdl_shapes.CHANNEL_CONV]
    weight = plain[0][conv.name][1][1]
    assert inputs[1] == weight and joined[2][weight] == plain[2][weight]
    assert np.array_equal(joined[1][weight].reshape(-1), plain[1][weight].reshape(-1))


def patches_reference(x: np.ndarray, kernel: int, stride: int, pad: int, depth: int) -> np.ndarray:
    """Each output pixel's window of an NCHW x as depth channels: kernel row, column, channel."""
    _n, c, h, w = x.shape
    padded = np.pad(x, ((0, 0), (0, 0), (pad, pad), (pad, pad)))
    rows, cols = (h + 2 * pad - kernel) // stride + 1, (w + 2 * pad - kernel) // stride + 1
    out = np.zeros((1, depth, rows, cols), x.dtype)
    for oy in range(rows):
        for ox in range(cols):
            top, left = oy * stride, ox * stride
            window = padded[0, :, top : top + kernel, left : left + kernel]
            out[0, : kernel * kernel * c, oy, ox] = window.transpose(1, 2, 0).reshape(-1)
    return out


def test_patch_weight_turns_a_strided_convolution_into_a_pointwise_one_over_patches() -> None:
    torch.manual_seed(3)
    x, w = torch.randn(1, 3, 12, 16), torch.randn(16, 3, 3, 3)
    pointwise = esp_ppq_patches.patch_weight(w)
    assert list(pointwise.shape) == [16, 32, 1, 1]
    assert not pointwise[:, 27:].any()
    patches = torch.from_numpy(patches_reference(x.numpy(), 3, 2, 1, 32))
    want = nn.functional.conv2d(x, w, stride=2, padding=1)
    assert torch.allclose(nn.functional.conv2d(patches, pointwise), want, atol=1e-5)


class RgbStem(nn.Module):
    """A 3x3 stride-2 convolution on an RGB image, its PReLU, then a pointwise convolution."""

    def __init__(self) -> None:
        super().__init__()
        self.stem = nn.Conv2d(3, 16, 3, stride=2, padding=1)
        self.slope = nn.PReLU(16)
        self.mix = nn.Conv2d(16, 16, 1)
        with torch.no_grad():
            self.slope.weight.uniform_(0.05, 0.3)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.mix(self.slope(self.stem(x)))


@pytest.mark.parametrize("rounding", [[], ["fused_prelu"]])
def test_im2col_convolutions_carry_the_stem_s_integers_into_patches(
    tmp_path: Path, rounding: list[str]
) -> None:
    pytest.importorskip("esp_ppq")
    torch.manual_seed(13)
    calib = [torch.rand(1, 3, 12, 16) for _ in range(4)]
    rungs = ptq_espdl.timing_rungs("antispoof")
    graph = quantise_ladder_net(RgbStem().eval(), tmp_path, calib, rungs, ("out",))
    assert [op.name for op in graph.operations.values() if esp_ppq_patches.im2col_ready(op)] == [
        "/stem/Conv"
    ]
    (port, *_), _outputs = ptq_espdl.ports_of(graph)
    test_input = ladder.on_grid(calib[0].numpy(), port.exponent)
    with esp_ppq_patches.applied(rounding):
        plain_file = export_espdl.export(graph, tmp_path / "plain.espdl", test_input)
    with esp_ppq_patches.applied(["im2col_convolutions", *rounding]):
        patched_file = export_espdl.export(graph, tmp_path / "patched.espdl", test_input)
    plain, patched = espdl_graph(plain_file), espdl_graph(patched_file)
    op, inputs, outputs = patched[0]["/stem/Conv"]
    plain_op, plain_inputs, plain_outputs = plain[0]["/stem/Conv"]
    assert op == espdl_shapes.IM2COL_CONV and outputs == plain_outputs
    assert plain_op == (espdl_shapes.FUSED_PRELU if rounding else "Conv")
    assert inputs[0] == plain_inputs[0] and len(inputs) == len(plain_inputs)
    weight, plain_weight = patched[1][inputs[1]], plain[1][plain_inputs[1]]
    assert weight.shape == (1, 1, 32, 16) and patched[2][inputs[1]] == plain[2][plain_inputs[1]]
    assert np.array_equal(filters(weight)[:, :27], filters(plain_weight))
    assert not filters(weight)[:, 27:].any()
    for param, plain_param in zip(inputs[2:], plain_inputs[2:], strict=True):
        assert np.array_equal(patched[1][param], plain[1][plain_param])
    info = espdl_shapes.parse(patched_file.with_suffix(".info").read_text(encoding="utf-8"))
    assert espdl_shapes.problems(info) == []
    ((attrs, ins),) = [(a, i) for o, a, i, _outs in info.nodes if o == espdl_shapes.IM2COL_CONV]
    shapes = [info.inputs.get(name, info.declared.get(name)) for name in ins]
    assert espdl_shapes.output_shape(espdl_shapes.IM2COL_CONV, attrs, shapes, [None] * 4)[1:] == [
        6,
        8,
        16,
    ]
    assert esp_ppq_patches.IM2COL_MARK not in attrs


class GatedResidual(nn.Module):
    """A residual block of MobileFaceNet-ECA: its input plus its convolution gated by ECA."""

    def __init__(self) -> None:
        super().__init__()
        self.conv = nn.Conv2d(16, 16, 1)
        self.eca = nn.Conv1d(1, 1, 3, padding=1, bias=False)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        y = self.conv(x)
        w = nn.functional.adaptive_avg_pool2d(y, 1)
        w = self.eca(w.squeeze(-1).transpose(-1, -2)).transpose(-1, -2).unsqueeze(-1)
        return x + y * torch.sigmoid(w)


def test_mul_add_joins_a_gated_residual_on_one_grid_and_refuses_another(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    pytest.importorskip("esp_ppq")
    torch.manual_seed(19)
    calib = [torch.rand(1, 16, 8, 8) for _ in range(4)]
    rungs = ptq_espdl.timing_rungs("recognition")
    graph = quantise_ladder_net(GatedResidual().eval(), tmp_path, calib, rungs, ("out",))
    (port, *_), _outputs = ptq_espdl.ports_of(graph)
    test_input = ladder.on_grid(calib[0].numpy(), port.exponent)
    plain_file = export_espdl.export(graph, tmp_path / "plain.espdl", test_input)
    with esp_ppq_patches.applied(["mul_add"]):
        joined_file = export_espdl.export(graph, tmp_path / "joined.espdl", test_input)
    plain, joined = espdl_graph(plain_file)[0], espdl_graph(joined_file)[0]
    ((_, (x, gate), (product,)),) = [n for n in plain.values() if n[0] == "Mul"]
    ((_, adds, (y,)),) = [n for n in plain.values() if n[0] == "Add"]
    (residual,) = [name for name in adds if name != product]
    assert not {"Mul", "Add"} & {op for op, _, _ in joined.values()}
    ((_, inputs, outputs),) = [n for n in joined.values() if n[0] == espdl_shapes.MUL_ADD]
    assert (inputs, outputs) == ([x, gate, residual], [y])
    info_text = joined_file.with_suffix(".info").read_text(encoding="utf-8")
    info = espdl_shapes.parse(info_text)
    assert espdl_shapes.problems(info) == []
    grids = {name: f"%{name}[" for name in (product, residual, y)}
    plain_text = plain_file.with_suffix(".info").read_text(encoding="utf-8")
    exponents = {
        name: next(line for line in plain_text.splitlines() if line.startswith(head)).split()[-1]
        for name, head in grids.items()
    }
    assert len(set(exponents.values())) == 1
    monkeypatch.setattr(esp_ppq_patches, "one_grid", lambda *_configs: False)
    with esp_ppq_patches.applied(["mul_add"]):
        apart_file = export_espdl.export(graph, tmp_path / "apart.espdl", test_input)
    assert {"Mul", "Add"} <= {op for op, _, _ in espdl_graph(apart_file)[0].values()}


class TwoGatedResiduals(nn.Module):
    """Two gated residual blocks, the second eight times as loud: its Add takes the first block's
    output on a coarser grid, through the RequantizeLinear ESP-PPQ puts before it.
    """

    def __init__(self) -> None:
        super().__init__()
        self.blocks = nn.ModuleList(GatedResidual() for _ in range(2))
        with torch.no_grad():
            self.blocks[1].conv.weight.mul_(8.0)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        for block in self.blocks:
            x = block(x)
        return x


def test_mul_add_takes_the_residual_from_before_its_requantize(tmp_path: Path) -> None:
    pytest.importorskip("esp_ppq")
    torch.manual_seed(23)
    calib = [torch.rand(1, 16, 8, 8) for _ in range(4)]
    rungs = ptq_espdl.timing_rungs("recognition")
    graph = quantise_ladder_net(TwoGatedResiduals().eval(), tmp_path, calib, rungs, ("out",))
    (port, *_), _outputs = ptq_espdl.ports_of(graph)
    test_input = ladder.on_grid(calib[0].numpy(), port.exponent)
    plain = espdl_graph(export_espdl.export(graph, tmp_path / "plain.espdl", test_input))[0]
    with esp_ppq_patches.applied(["mul_add"]):
        joined = espdl_graph(export_espdl.export(graph, tmp_path / "joined.espdl", test_input))[0]
    requants = {outs[0]: ins[0] for op, ins, outs in plain.values() if op == "RequantizeLinear"}
    second = next(ins for op, ins, _ in plain.values() if op == "Add" and set(ins) & set(requants))
    (regridded,) = set(second) & set(requants)
    assert [op for op, _, _ in joined.values()].count("RequantizeLinear") == len(requants) - 1
    muladds = [ins for op, ins, _ in joined.values() if op == espdl_shapes.MUL_ADD]
    assert len(muladds) == 2
    assert requants[regridded] in [ins[2] for ins in muladds]


class ExpandDepthwise(nn.Module):
    """A 1x1 expansion that only a 3x3 depthwise reads, then a 1x1 projection, as in MobileFaceNet;
    shared adds the expansion back after the depthwise, so the middle tensor has a second reader.
    """

    def __init__(self, stride: int, shared: bool = False) -> None:
        super().__init__()
        self.expand = nn.Conv2d(16, 32, 1)
        self.depthwise = nn.Conv2d(32, 32, 3, stride=stride, padding=1, groups=32)
        self.project = nn.Conv2d(32, 16, 1)
        self.shared = shared

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        middle = torch.relu(self.expand(x))
        y = torch.relu(self.depthwise(middle))
        return self.project(y + middle if self.shared else y)


def exported_pair(tmp_path: Path, model: nn.Module, patches: list[str]) -> Path:
    torch.manual_seed(29)
    calib = [torch.rand(1, 16, 10, 10) for _ in range(4)]
    rungs = ptq_espdl.timing_rungs("recognition")
    graph = quantise_ladder_net(model.eval(), tmp_path, calib, rungs, ("out",))
    (port, *_), _outputs = ptq_espdl.ports_of(graph)
    test_input = ladder.on_grid(calib[0].numpy(), port.exponent)
    with esp_ppq_patches.applied(patches):
        return export_espdl.export(
            graph, tmp_path / f"{'_'.join(patches) or 'plain'}.espdl", test_input
        )


@pytest.mark.parametrize("stride", [1, 2])
def test_pointwise_depthwise_joins_an_expansion_with_its_depthwise(
    tmp_path: Path, stride: int
) -> None:
    pytest.importorskip("esp_ppq")
    torch.manual_seed(31)
    model = ExpandDepthwise(stride)
    plain_file = exported_pair(tmp_path / "plain", model, [])
    joined_file = exported_pair(tmp_path / "joined", model, ["pointwise_depthwise"])
    (plain, plain_tensors, plain_exps) = espdl_graph(plain_file)
    (joined, joined_tensors, joined_exps) = espdl_graph(joined_file)
    convs = {outs[0]: ins for op, ins, outs in plain.values() if op == "Conv"}
    read = [ins[0] for ins in convs.values()]
    (dw_out,) = [out for out, ins in convs.items() if ins[0] in convs and out in read]
    middle, dw_params = convs[dw_out][0], convs[dw_out][1:]
    expand_ins = convs[middle]
    ((_, inputs, outputs),) = [
        n for n in joined.values() if n[0] == espdl_shapes.POINTWISE_DEPTHWISE
    ]
    assert (inputs, outputs) == ([*expand_ins, *dw_params], [dw_out])
    assert [op for op, _, _ in joined.values()].count("Conv") == 1
    for name in [*expand_ins[1:], *dw_params]:
        assert np.array_equal(joined_tensors[name], plain_tensors[name]), name
        assert joined_exps[name] == plain_exps[name], name
    info = espdl_shapes.parse(joined_file.with_suffix(".info").read_text(encoding="utf-8"))
    assert espdl_shapes.problems(info) == []
    (attrs,) = [a for op, a, _ins, _outs in info.nodes if op == espdl_shapes.POINTWISE_DEPTHWISE]
    plain_text = plain_file.with_suffix(".info").read_text(encoding="utf-8")
    line = next(line for line in plain_text.splitlines() if line.startswith(f"%{middle}["))
    assert espdl_shapes.attribute(attrs, "middle_exponent") == int(line.split()[-1].strip("[]"))
    assert espdl_shapes.attribute(attrs, "pointwise_inputs") == len(expand_ins) - 1
    assert espdl_shapes.attribute(attrs, "depthwise_inputs") == len(dw_params)
    assert espdl_shapes.attribute(attrs, "pointwise_activation") == "Relu"


def test_pointwise_depthwise_joins_a_pair_whose_prelus_are_fused(sloped, tmp_path: Path) -> None:
    graph, calib, _fusable = sloped
    (port, *_), _outputs = ptq_espdl.ports_of(graph)
    test_input = ladder.on_grid(calib[0].numpy(), port.exponent)
    with esp_ppq_patches.applied(["fused_prelu"]):
        fused = espdl_graph(export_espdl.export(graph, tmp_path / "fused.espdl", test_input))
    with esp_ppq_patches.applied(["fused_prelu", "pointwise_depthwise"]):
        joined_file = export_espdl.export(graph, tmp_path / "joined.espdl", test_input)
    joined = espdl_graph(joined_file)
    _op, pw_inputs, (middle,) = fused[0]["/pointwise/Conv"]
    _op, dw_inputs, dw_outputs = fused[0]["/depthwise/Conv"]
    assert dw_inputs[0] == middle
    ((_, inputs, outputs),) = [
        n for n in joined[0].values() if n[0] == espdl_shapes.POINTWISE_DEPTHWISE
    ]
    assert (inputs, outputs) == ([*pw_inputs, *dw_inputs[1:]], dw_outputs)
    for name in [*pw_inputs[1:], *dw_inputs[1:]]:
        assert np.array_equal(joined[1][name], fused[1][name]), name
        assert joined[2][name] == fused[2][name], name
    info = espdl_shapes.parse(joined_file.with_suffix(".info").read_text(encoding="utf-8"))
    assert espdl_shapes.problems(info) == []
    (attrs,) = [a for op, a, _ins, _outs in info.nodes if op == espdl_shapes.POINTWISE_DEPTHWISE]
    assert espdl_shapes.attribute(attrs, "pointwise_activation") == "PRelu"
    assert espdl_shapes.attribute(attrs, "activation") == "PRelu"
    assert espdl_shapes.attribute(attrs, "pointwise_inputs") == 3
    assert espdl_shapes.attribute(attrs, "depthwise_inputs") == 3


def test_pointwise_depthwise_leaves_a_middle_tensor_another_op_reads(tmp_path: Path) -> None:
    pytest.importorskip("esp_ppq")
    shared = ExpandDepthwise(1, shared=True)
    joined_file = exported_pair(tmp_path, shared, ["pointwise_depthwise"])
    ops = [op for op, _, _ in espdl_graph(joined_file)[0].values()]
    assert espdl_shapes.POINTWISE_DEPTHWISE not in ops
    assert ops.count("Conv") == 3


def test_ai_engine_registers_every_module_the_patches_export() -> None:
    core = REPO_ROOT / espdl_op_check.AI_ENGINE_CORE
    found = espdl_op_check.own_modules(core)
    own = {espdl_shapes.FUSED_PRELU, espdl_shapes.SLICED_CONV, espdl_shapes.CHANNEL_CONV}
    joined = {espdl_shapes.IM2COL_CONV, espdl_shapes.MUL_ADD, espdl_shapes.POINTWISE_DEPTHWISE}
    assert own | joined <= found
