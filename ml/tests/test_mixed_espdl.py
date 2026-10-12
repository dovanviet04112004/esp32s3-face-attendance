"""KEHOACH 3.7 rung 3: the layers ranked by ESP-PPQ's per-layer error, worst first."""

from __future__ import annotations

import numpy as np

from facepipe.compress.quant import mixed_espdl, ptq_espdl


def test_each_row_takes_the_worst_layers_first() -> None:
    ranked = [("a", 3.0), ("b", 2.0), ("c", 1.0)]
    rows = mixed_espdl.int16_rows(ranked, [1, 2, 8])
    assert rows == {"int16_top1": ["a"], "int16_top2": ["a", "b"], "int16_top8": ["a", "b", "c"]}


def test_every_computing_layer_is_ranked_and_the_graph_is_left_as_found(ladder_graph) -> None:
    graph = ladder_graph.graph
    x = ladder_graph.calib[0].numpy()
    before = ptq_espdl.Simulator(graph, device="cpu")(x)
    ranked = mixed_espdl.ranked_layers(graph, ladder_graph.calib[:4])
    computing = {op.name for op in graph.operations.values() if op.type in {"Conv", "Gemm"}}
    assert {name for name, _ in ranked} == computing
    errors = [error for _, error in ranked]
    assert errors == sorted(errors, reverse=True)
    assert all(error >= 0.0 for error in errors)
    after = ptq_espdl.Simulator(graph, device="cpu")(x)
    assert all(np.array_equal(a, b) for a, b in zip(before, after, strict=True))
