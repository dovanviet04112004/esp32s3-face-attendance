"""KEHOACH 3.7 step 2.2: esp-dl's profile print read back and joined to the .espdl that ran."""

from __future__ import annotations

from pathlib import Path

import pytest

from facepipe.compress.quant import espdl_profile, export_espdl, ladder, ptq_espdl

# Rows as dl_model_base.cpp of esp-dl 3.3.11 prints them through ESP_LOGI.
MODULES = """I (900) dl::Model: | name       | type | latency |
I (901) dl::Model: | /stem/Conv | Conv | 1200us  |
I (902) dl::Model: | /add/Add   | Add  | 40us    |
I (903) dl::Model: | /stem/Cov  | Conv | 7us     |
I (904) dl::Model: | total      |      | 1247us  |
"""
MEMORY = """I (800) dl::Model: |                | internal RAM | PSRAM     | FLASH   |
I (801) dl::Model: | fbs_model      |              |           | 12.50KB |
I (802) dl::Model: | total          | 3.25KB       | 140.75KB  | 12.50KB |
"""


def module(op: str, inputs: list[str], outputs: list[str], us: int = 1200, attrs: str = ""):
    return espdl_profile.Module("m", op, us, inputs, outputs, attrs)


def test_rows_are_read_and_a_garbled_name_is_dropped_against_the_graph() -> None:
    assert espdl_profile.profile(MODULES) == {
        "/stem/Conv": ("Conv", 1200),
        "/add/Add": ("Add", 40),
        "/stem/Cov": ("Conv", 7),
    }
    graph = {"/stem/Conv": ("Conv", [], []), "/add/Add": ("Mul", [], [])}
    assert espdl_profile.profile(MODULES, graph) == {"/stem/Conv": ("Conv", 1200)}


def test_the_memory_total_is_read_and_a_blank_cell_is_zero() -> None:
    assert espdl_profile.memory(MEMORY) == {"internal": 3.25, "psram": 140.75, "flash": 12.5}
    assert espdl_profile.memory(MODULES) is None


def test_the_chip_is_the_firmware_s() -> None:
    assert espdl_profile.chip() == (240, 64 * 1024)


def test_a_convolution_is_tagged_for_channels_and_for_the_data_cache() -> None:
    laid = {"x": [1, 16, 16, 3], "w": [3, 3, 3, 24], "y": [1, 8, 8, 24]}
    tags, rate = espdl_profile.conv_tags(module("Conv", ["x", "w"], ["y"]), laid, 240, 65536)
    assert tags == ["unaligned 3 -> 24 channels (no export patch)"]
    assert rate == pytest.approx(1200 * 240 / (8 * 8 * 24 * 3 * 9))

    laid = {"x": [1, 7, 7, 512], "w": [1, 1, 512, 512], "y": [1, 7, 7, 512]}
    tags, _rate = espdl_profile.conv_tags(module("Conv", ["x", "w"], ["y"]), laid, 240, 65536)
    assert tags == ["256 KB of weights outgrow the cache (cache_sized_convolutions)"]

    tags, rate = espdl_profile.conv_tags(module("Conv", ["x", "w"], ["y"]), {}, 240, 65536)
    assert (tags, rate) == ([], None)


def test_the_other_slow_paths_name_their_patch() -> None:
    def tags(op: str, laid: dict | None = None, attrs: str = "") -> list[str]:
        found = module(op, ["a"], ["b"], attrs=attrs)
        return espdl_profile.tags_of(found, laid or {}, {}, 240, 65536)[0]

    assert tags("Transpose") == ["layout copy (lean_transposes)"]
    assert tags("RequantizeLinear") == ["grid change (lean_quantizers when repeated)"]
    assert tags("Softmax") == ["esp-dl's int8 kernel works in float32 per value (no export patch)"]
    assert tags("MatMul", {"b": [1, 4, 8]}) == [
        "8 output columns run in C (lay the product transposed)"
    ]
    assert tags("Add", attrs="quant_type = 'F32'") == ["runs in float"]
    assert tags("Add") == []


def test_a_report_joins_the_log_to_the_exported_graph(ladder_graph, tmp_path: Path) -> None:
    (port, *_), _outputs = ptq_espdl.ports_of(ladder_graph.graph)
    test_input = ladder.on_grid(ladder_graph.calib[0].numpy(), port.exponent)
    espdl = export_espdl.export(ladder_graph.graph, tmp_path / "net.espdl", test_input)
    graph = espdl_profile.nodes(espdl)
    assert graph
    assert {op for op, _ins, _outs in graph.values()} >= {"Conv", "Add"}
    rows = [
        f"I (9) dl::Model: | {name} | {op} | {10 * (i + 1)}us |"
        for i, (name, (op, *_)) in enumerate(graph.items())
    ]
    log = MEMORY + "\n".join(rows) + "\n"
    text = espdl_profile.report(log, espdl, top=3)
    total_ms = sum(10 * (i + 1) for i in range(len(graph))) / 1000
    assert text.splitlines()[0] == f"{total_ms:.1f} ms over {len(graph)} modules of net.espdl"
    assert "memory: internal 3.2 KB, psram 140.8 KB, flash 12.5 KB" in text
    assert "by op type:" in text
    assert "slowest 3 modules:" in text
