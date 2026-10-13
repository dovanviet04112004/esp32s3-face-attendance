"""KEHOACH 3.7: esp-dl's shape rules replayed over an .info, so a bad graph stops on the host."""

from __future__ import annotations

from pathlib import Path

import pytest

from facepipe.compress.quant import espdl_shapes, export_espdl, ladder, ptq_espdl

CONV = (
    "dilations = [1, 1], group = {group}, kernel_shape = [3, 3], pads = {pads}, "
    "strides = [{s}, {s}]"
)


def conv_attrs(pads: list[int], stride: int = 1, group: int = 1) -> str:
    return CONV.format(group=group, pads=pads, s=stride)


def test_esp_dl_broadcasts_by_the_larger_size_without_asking_onnx() -> None:
    assert espdl_shapes.broadcast([1, 8, 8, 16], [16]) == ([1, 8, 8, 16], True)
    assert espdl_shapes.broadcast([2, 3], [4, 3]) == ([4, 3], False)


def test_a_convolution_reads_its_pads_in_esp_dl_order() -> None:
    x, w = [1, 10, 10, 3], [3, 3, 3, 8]
    assert espdl_shapes.output_shape("Conv", conv_attrs([1, 1, 0, 0], 2), [x, w], [None, None]) == [
        1,
        5,
        4,
        8,
    ]
    assert espdl_shapes.output_shape("Conv", conv_attrs([1, 1, 1, 1], 2), [x, w], [None, None]) == [
        1,
        5,
        5,
        8,
    ]


def test_a_grouped_convolution_keeps_its_input_channels() -> None:
    x, w = [1, 8, 8, 16], [3, 3, 1, 16]
    got = espdl_shapes.output_shape("Conv", conv_attrs([1, 1, 1, 1], 1, 16), [x, w], [None, None])
    assert got == [1, 8, 8, 16]


def test_a_convolution_with_its_prelu_joined_shapes_as_the_convolution() -> None:
    x, w, attrs = [1, 8, 8, 16], [3, 3, 1, 16], conv_attrs([1, 1, 1, 1], 1, 16)
    shapes = [x, w, [16], [16]]
    got = espdl_shapes.output_shape(espdl_shapes.FUSED_PRELU, attrs, shapes, [None] * 4)
    assert got == [1, 8, 8, 16]


def test_a_sliced_convolution_lays_out_every_slice_s_channels() -> None:
    x, w = [1, 14, 14, 128], [1, 1, 128, 256]
    attrs = "dilations = [1, 1], group = 1, kernel_shape = [1, 1], pads = [0, 0, 0, 0], "
    attrs += "slices = [256, 256], strides = [1, 1]"
    shapes = [x, w, [256], w, [256]]
    got = espdl_shapes.output_shape(espdl_shapes.SLICED_CONV, attrs, shapes, [None] * 5)
    assert got == [1, 14, 14, 512]


def test_pooling_flattening_and_unknown_ops() -> None:
    x = [1, 4, 4, 32]
    assert espdl_shapes.output_shape("GlobalAveragePool", "", [x], [None]) == [1, 1, 1, 32]
    assert espdl_shapes.output_shape("Flatten", "axis = 1", [[1, 1, 1, 32]], [None]) == [1, 32]
    assert espdl_shapes.output_shape("Squeeze", "", [[1, 1, 1, 32], [2]], [None, [1, 2]]) == [1, 32]
    assert espdl_shapes.output_shape("PRelu", "", [x, [32]], [None, None]) == x
    assert espdl_shapes.output_shape("NoSuchOp", "", [x], [None]) is None


def test_every_way_the_chip_breaks_is_named() -> None:
    info = espdl_shapes.Info(
        inputs={"x": [1, 4, 4, 8], "small": [1, 2, 2, 3]},
        declared={"w": [5, 5, 3, 4], "other": [1, 4, 4, 3]},
        values={"shape": [1, 100]},
        nodes=[
            ("Reshape", "", ["x", "shape"], ["r"]),
            ("Add", "", ["x", "other"], ["a"]),
            ("Conv", conv_attrs([0, 0, 0, 0]), ["small", "w"], ["c"]),
        ],
    )
    found = espdl_shapes.problems(info)
    assert len(found) == 3
    assert found[0].startswith("r: Reshape of [1, 4, 4, 8]")
    assert found[1].startswith("a: Add broadcasts")
    assert found[2].startswith("c: Conv gives")


def test_an_exported_graph_parses_and_builds_as_simulated(ladder_graph, tmp_path: Path) -> None:
    (port, *_), _outputs = ptq_espdl.ports_of(ladder_graph.graph)
    test_input = ladder.on_grid(ladder_graph.calib[0].numpy(), port.exponent)
    espdl = export_espdl.export(ladder_graph.graph, tmp_path / "net.espdl", test_input)
    info = espdl_shapes.parse(espdl.with_suffix(".info").read_text(encoding="utf-8"))
    assert info.inputs == {"image": [1, 16, 16, 3]}
    assert {op for op, *_ in info.nodes} >= {"Conv", "Add"}
    assert espdl_shapes.problems(info) == []


def test_check_refuses_an_info_the_chip_cannot_build(tmp_path: Path, monkeypatch) -> None:
    broken = espdl_shapes.Info(
        inputs={"x": [1, 4, 4, 8]},
        values={"shape": [3]},
        nodes=[("Reshape", "", ["x", "shape"], ["r"])],
    )
    monkeypatch.setattr(espdl_shapes, "parse", lambda _text: broken)
    info_file = tmp_path / "net.info"
    info_file.write_text("", encoding="utf-8")
    with pytest.raises(ValueError, match="Reshape"):
        espdl_shapes.check(info_file)
