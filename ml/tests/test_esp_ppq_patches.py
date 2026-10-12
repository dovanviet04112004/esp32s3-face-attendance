"""KEHOACH 3.7: a branch's ESP-PPQ patches enter in order, leave in reverse, and all exist."""

from __future__ import annotations

import contextlib
import math
from pathlib import Path

import numpy as np
import pytest
import torch
from torch import nn

from facepipe.compress.quant import esp_ppq_patches, export_espdl, ptq_espdl
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
        names = ptq_espdl.block(branch)["esp_ppq_patches"]
        assert set(names) <= set(esp_ppq_patches.PATCHES), branch


def espdl_graph(path: Path) -> tuple[dict, dict]:
    """An .espdl's nodes by name as (op, inputs), and its initializers by name as arrays."""
    import flatbuffers

    graph = espdl_op_check.graph(path)
    nodes = {}
    for i in range(graph.NodeLength()):
        node = graph.Node(i)
        inputs = [node.Input(j).decode() for j in range(node.InputLength())]
        nodes[node.Name().decode()] = (node.OpType().decode(), inputs)
    dtypes, tensors = {1: np.float32, 3: np.int8, 6: np.int32, 7: np.int64}, {}
    for i in range(graph.InitializerLength()):
        t = graph.Initializer(i)
        dims = [int(d) for d in t.DimsAsNumpy()]
        start = t._tab.Vector(flatbuffers.number_types.UOffsetTFlags.py_type(t._tab.Offset(20)))
        raw = bytes(t._tab.Bytes[start : start + 16 * t.RawDataLength()])
        data = np.frombuffer(raw, dtypes[t.DataType()])[: math.prod(dims)]
        tensors[t.Name().decode()] = data.reshape(dims)
    return nodes, tensors


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
    convs = {name: ins for name, (op, ins) in plain[0].items() if op == "Conv"}
    kept = {name: ins for name, (op, ins) in sliced[0].items() if op == "Conv" and name in convs}
    parts = [ins for name, (op, ins) in sliced[0].items() if op == "Conv" and name not in convs]
    assert [op for op, _ in sliced[0].values()].count("Concat") == 1
    assert list(kept) == ["/narrow/Conv"]
    assert np.array_equal(plain[1][convs["/narrow/Conv"][1]], sliced[1][kept["/narrow/Conv"][1]])
    assert [sliced[1][ins[1]].shape[-1] for ins in parts] == [256, 256]
    weights = np.concatenate([filters(sliced[1][ins[1]]) for ins in parts])
    assert np.array_equal(weights, filters(plain[1][convs["/expand/Conv"][1]]))
    biases = np.concatenate([sliced[1][ins[2]] for ins in parts])
    assert np.array_equal(biases, plain[1][convs["/expand/Conv"][2]])


def test_the_export_hook_is_put_back_after_the_patch() -> None:
    pytest.importorskip("esp_ppq")
    from esp_ppq.parser import espdl_exporter

    kept = espdl_exporter.reset_graph_layout
    with esp_ppq_patches.applied(["cache_sized_convolutions"]):
        assert espdl_exporter.reset_graph_layout is not kept
    assert espdl_exporter.reset_graph_layout is kept
