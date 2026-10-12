"""KEHOACH 3.7: the probe's cuts, frame record and images, checked before the board sees them."""

from __future__ import annotations

import json
import struct
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest

from facepipe import tasks
from facepipe.compress.quant import export_espdl, ladder, probe, ptq_espdl
from facepipe.export import emit_golden, pack_models_partition


def test_a_sample_is_laid_channels_last() -> None:
    y = np.arange(2 * 3 * 4 * 5).reshape(2, 3, 4, 5)
    got = probe.laid(y)
    assert got.shape == (4, 5, 3)
    assert got[1, 2, 0] == y[0, 0, 1, 2]
    assert probe.laid(np.arange(8).reshape(1, 8)).tolist() == list(range(8))
    assert probe.laid(np.arange(12).reshape(1, 3, 4)).shape == (4, 3)


def test_every_cut_computes_what_the_whole_graph_computes_there(
    ladder_graph, tmp_path: Path
) -> None:
    from esp_ppq.executor.torch import TorchExecutor

    graph = ladder_graph.graph
    held = len(graph.operations)
    points = probe.cut_points(graph, 4)
    assert points
    assert [i for i, _ in points] == sorted({i for i, _ in points})
    (port, *_), _outputs = ptq_espdl.ports_of(graph)
    x = ladder.on_grid(ladder_graph.calib[0].numpy(), port.exponent)
    whole = TorchExecutor(graph=graph, device="cpu")
    for k, (_index, name) in enumerate(points):
        assert name not in graph.outputs
        cut = probe.truncated(graph, name)
        assert list(cut.outputs) == [name]
        assert len(cut.operations) < held
        there = whole.forward(inputs=ladder_graph.calib[0], output_names=[name])[0].numpy()
        assert np.array_equal(ptq_espdl.Simulator(cut, device="cpu")(x)[0], there)
        export_espdl.export(cut, tmp_path / f"c{k}.espdl", x)
    assert len(graph.operations) == held


def test_the_frame_record_carries_what_the_board_compares(ladder_graph, tmp_path: Path) -> None:
    graph = ladder_graph.graph
    (port, *_), outputs = ptq_espdl.ports_of(graph)
    frames = np.concatenate([c.numpy() for c in ladder_graph.calib[:2]])
    xs = ladder.on_grid(frames, port.exponent)
    record = probe.frames_record(graph, xs, [])
    assert record["in_exp"].tolist() == [port.exponent]
    assert {out.name: record[f"exp.{out.name}"].tolist() for out in outputs} == {
        out.name: [out.exponent] for out in outputs
    }
    assert record["x1"].dtype == np.int8
    assert record["x1"].shape == (16, 16, 3)
    assert record["y1.map"].shape == (8, 8, 16)
    vector = ptq_espdl.Simulator(graph, device="cpu")(xs[1:2])[0]
    assert np.array_equal(record["y1.vector"], ptq_espdl.to_int8(vector, outputs[0].exponent)[0])
    back = emit_golden.read_case(emit_golden.write_case(tmp_path / "frames.gold", record))
    assert all(np.array_equal(back[name], value) for name, value in record.items())


def fake_espdl(path: Path, size: int) -> Path:
    path.write_bytes(b"EDL2" + bytes(size - 4))
    return path


def entry_names(image: Path) -> list[str]:
    blob = image.read_bytes()
    magic, _version, count, _built = struct.unpack_from("<4sIII", blob, 0)
    assert magic == pack_models_partition.MAGIC
    size = struct.calcsize(pack_models_partition.ENTRY_FORMAT)
    return [
        struct.unpack_from(pack_models_partition.ENTRY_FORMAT, blob, 16 + i * size)[0]
        .rstrip(b"\0")
        .decode()
        for i in range(count)
    ]


def test_images_fill_their_slots_and_capacity_in_order(tmp_path: Path) -> None:
    sizes = [1000, 400, 400, 400, 900]
    entries = [
        ("recog" if k == 0 else f"recog_c{k - 1}", fake_espdl(tmp_path / f"{k}.espdl", size))
        for k, size in enumerate(sizes)
    ]
    images = probe.packed(entries, (112, 112), pack_models_partition.HEADER_BYTES + 2000, tmp_path)
    assert [entry_names(image) for image in images] == [
        ["recog", "recog_c0", "recog_c1"],
        ["recog_c2", "recog_c3"],
    ]
    images = probe.packed(entries, (112, 112), pack_models_partition.HEADER_BYTES + 1500, tmp_path)
    assert [entry_names(image) for image in images] == [
        ["recog", "recog_c0"],
        ["recog_c1", "recog_c2"],
        ["recog_c3"],
    ]
    with pytest.raises(ValueError, match="a model slot holds"):
        probe.packed(entries, (112, 112), 900, tmp_path)


def test_a_probe_writes_its_graphs_record_and_manifest(
    ladder_graph, tmp_path: Path, monkeypatch
) -> None:
    run = tmp_path / "run"
    export_espdl.save_native(ladder_graph.graph, ladder.row_dir(run, "kl") / ladder.GRAPH_FILE)
    frames = np.concatenate([c.numpy() for c in ladder_graph.calib])
    hooks = SimpleNamespace(probe_inputs=lambda _cfg, _frames, count: frames[:count])
    monkeypatch.setattr(tasks, "branch_of", lambda _run: "recognition")
    monkeypatch.setattr(ladder, "hooks_of", lambda _run: hooks)
    cfg = SimpleNamespace(model=SimpleNamespace(input_hw=[16, 16]))
    monkeypatch.setattr(ladder, "config_of", lambda _run: cfg)
    monkeypatch.setattr(ladder, "device_frames", lambda: ())
    monkeypatch.setattr(probe, "RECORD", tmp_path / "app" / "frames.gold")
    monkeypatch.setattr(probe, "MANIFEST", tmp_path / "app" / "manifest.json")

    manifest = json.loads(probe.probe(run, "kl").read_text(encoding="utf-8"))
    points = probe.cut_points(ladder_graph.graph, ptq_espdl.block("recognition")["probe"]["cuts"])
    assert manifest["branch"] == "recognition"
    assert manifest["entries"] == ["recog", *(f"recog_c{k}" for k in range(len(points)))]
    assert manifest["frames"] == len(frames)
    assert manifest["whole_espdl"] == str(ladder.row_dir(run, "kl") / "probe" / "recog.espdl")
    assert len(manifest["images"]) == len(manifest["logs"]) == -(-(len(points) + 1) // 3)
    assert manifest["whole_log"] == manifest["logs"][0]
    assert entry_names(Path(manifest["images"][0]))[0] == "recog"
    record = emit_golden.read_case(Path(manifest["record"]))
    assert {f"x{i}" for i in range(len(frames))} <= set(record)
