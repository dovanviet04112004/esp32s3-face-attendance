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
    convs = {name: ins for name, (op, ins, _) in plain[0].items() if op == "Conv"}
    kept = {name: ins for name, (op, ins, _) in sliced[0].items() if op == "Conv" and name in convs}
    parts = [ins for name, (op, ins, _) in sliced[0].items() if op == "Conv" and name not in convs]
    assert [op for op, _, _ in sliced[0].values()].count("Concat") == 1
    assert list(kept) == ["/narrow/Conv"]
    assert np.array_equal(plain[1][convs["/narrow/Conv"][1]], sliced[1][kept["/narrow/Conv"][1]])
    assert [sliced[1][ins[1]].shape[-1] for ins in parts] == [256, 256]
    weights = np.concatenate([filters(sliced[1][ins[1]]) for ins in parts])
    assert np.array_equal(weights, filters(plain[1][convs["/expand/Conv"][1]]))
    biases = np.concatenate([sliced[1][ins[2]] for ins in parts])
    assert np.array_equal(biases, plain[1][convs["/expand/Conv"][2]])


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


def test_ai_engine_registers_the_fused_module() -> None:
    core = REPO_ROOT / espdl_op_check.AI_ENGINE_CORE
    assert espdl_shapes.FUSED_PRELU in espdl_op_check.own_modules(core)
