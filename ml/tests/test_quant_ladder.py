"""KEHOACH 3.7: the ladder's rows, its row choice and each branch's gate, without a run."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
import torch
import yaml

from facepipe import ML_ROOT, REPO_ROOT, tasks
from facepipe.compress.quant import esp_ppq_patches, export_espdl, ladder, ptq_espdl
from facepipe.tasks.antispoof import quant as antispoof_quant
from facepipe.tasks.detection import quant as detection_quant
from facepipe.tasks.recognition import quant as recognition_quant
from tests.conftest import quantise_ladder_net


def test_a_run_reaches_its_branch_through_run_task(tmp_path: Path, config_tree: dict) -> None:
    from facepipe.core.config import CONFIG_NAME

    config_tree["run"]["task"] = "recognition"
    (tmp_path / CONFIG_NAME).write_text(yaml.safe_dump(config_tree), encoding="utf-8")
    assert tasks.branch_of(tmp_path) == "recognition"
    assert tasks.module_of(tmp_path, "quant") is recognition_quant
    assert ladder.hooks_of(tmp_path) is recognition_quant


def test_rows_are_written_kept_and_tabled(tmp_path: Path) -> None:
    ladder.write_row(tmp_path, "float", {"rung": 0, "metrics": {"m": 1.0}, "headline": "q0"})
    ladder.write_row(
        tmp_path, "kl", {"rung": 2, "metrics": {"m": 0.9}, "headline": "x", "passes": False}
    )
    ladder.write_row(
        tmp_path, "kl", {"rung": 2, "metrics": {"m": 0.95}, "headline": "y", "passes": True}
    )
    rows = ladder.read_ladder(tmp_path)
    assert list(rows) == ["float", "kl"]
    assert rows["kl"]["metrics"] == {"m": 0.95}
    assert ladder.table(tmp_path).splitlines()[1].split() == ["2", "kl", "y", "pass"]
    assert ladder.row_dir(tmp_path, "kl") == tmp_path / "int8" / "kl"


def test_the_best_row_is_first_by_the_branch_ruler(tmp_path: Path, monkeypatch) -> None:
    hooks = SimpleNamespace(rank=lambda metrics: (metrics["m"],))
    monkeypatch.setattr(ladder, "hooks_of", lambda _run: hooks)
    for name, rung, m in (("minmax", 2, 0.8), ("kl", 2, 0.9), ("int16_top1", 3, 0.95)):
        ladder.write_row(tmp_path, name, {"rung": rung, "metrics": {"m": m}})
    ladder.write_row(tmp_path, "timing", {"rung": "timing"})
    variant = {"rung": 3, "metrics": {"m": 0.99}, "patches": ["fused_prelu"]}
    ladder.write_row(tmp_path, "int16_top1+fused_prelu", variant)
    assert ladder.best_row(tmp_path, {2}) == "kl"
    assert ladder.best_row(tmp_path, {2, 3}) == "int16_top1"
    with pytest.raises(ValueError, match="no row of rung"):
        ladder.best_row(tmp_path, {4})


def test_the_best_row_passes_its_gate_while_one_does(tmp_path: Path, monkeypatch) -> None:
    hooks = SimpleNamespace(rank=lambda metrics: (metrics["m"],))
    monkeypatch.setattr(ladder, "hooks_of", lambda _run: hooks)
    ladder.write_row(tmp_path, "percentile", {"rung": 2, "metrics": {"m": 0.95}, "passes": False})
    ladder.write_row(tmp_path, "kl", {"rung": 2, "metrics": {"m": 0.9}, "passes": True})
    ladder.write_row(tmp_path, "mse", {"rung": 2, "metrics": {"m": 0.8}, "passes": True})
    assert ladder.best_row(tmp_path, {2}) == "kl"
    ladder.write_row(tmp_path, "kl", {"rung": 2, "metrics": {"m": 0.9}, "passes": False})
    ladder.write_row(tmp_path, "mse", {"rung": 2, "metrics": {"m": 0.8}, "passes": False})
    assert ladder.best_row(tmp_path, {2}) == "percentile"


def test_inputs_are_moved_onto_the_grid_the_chip_receives() -> None:
    x = np.array([0.1, 0.26, -5.0, 1.0, 100.0], dtype=np.float32)
    assert ladder.on_grid(x, -2).tolist() == [0.0, 0.25, -5.0, 1.0, 127 * 0.25]


def test_a_runner_without_a_batch_path_goes_one_by_one() -> None:
    calls: list[int] = []

    class OneByOne:
        batched = False

        def __call__(self, x: np.ndarray) -> list[np.ndarray]:
            calls.append(len(x))
            return [x * 2, x[:, :1]]

    x = np.arange(12, dtype=np.float32).reshape(3, 4)
    doubled, first = ladder.run_batch(OneByOne(), x)
    assert calls == [1, 1, 1]
    assert np.array_equal(doubled, x * 2)
    assert first.shape == (3, 1)


def test_training_batches_are_whole() -> None:
    calib = [torch.full((1, 2), float(i)) for i in range(5)]
    got = ladder.batched(calib, 2)
    assert [tuple(t.shape) for t in got] == [(2, 2), (2, 2)]
    assert got[1][:, 0].tolist() == [2.0, 3.0]


def test_the_ends_of_the_graph_are_found(ladder_graph) -> None:
    graph = ladder_graph.graph
    stem = graph.variables["image"].dest_ops[0].name
    head = graph.variables["vector"].source_op.name
    convs = [op.name for op in graph.operations.values() if op.type == "Conv"]
    body = next(name for name in convs if name != stem)
    assert ladder.touches_ends(graph, stem)
    assert ladder.touches_ends(graph, head)
    assert not ladder.touches_ends(graph, body)


def test_rung_four_waits_for_the_owner(tmp_path: Path) -> None:
    with pytest.raises(SystemExit, match="ALLOW_TRAIN=1"):
        ladder.step_qat(tmp_path, allow_train=False, steps=None)


def test_a_row_whose_ports_are_not_int8_never_reaches_the_lock(
    ladder_graph, tmp_path: Path, monkeypatch
) -> None:
    head = ladder_graph.graph.variables["vector"].source_op.name
    rungs = {**ptq_espdl.timing_rungs("recognition"), "int16_ops": [head]}
    wide = quantise_ladder_net(ladder_graph.model, tmp_path / "work", ladder_graph.calib, rungs)
    export_espdl.save_native(wide, ladder.row_dir(tmp_path, "int16_top1") / ladder.GRAPH_FILE)
    monkeypatch.setattr(tasks, "branch_of", lambda _run: "recognition")
    with pytest.raises(SystemExit, match="int8"):
        ladder.step_deploy(tmp_path, "int16_top1")


def test_a_row_reaches_the_repo_s_lock_from_whatever_directory(
    ladder_graph, tmp_path: Path, monkeypatch
) -> None:
    wide = quantise_ladder_net(
        ladder_graph.model,
        tmp_path / "work",
        ladder_graph.calib,
        ptq_espdl.timing_rungs("recognition"),
    )
    export_espdl.save_native(wide, ladder.row_dir(tmp_path, "kl") / ladder.GRAPH_FILE)
    monkeypatch.setattr(tasks, "branch_of", lambda _run: "recognition")
    seen: list[list[str]] = []
    monkeypatch.setattr(ladder.update_lock, "main", seen.append)
    monkeypatch.chdir(tmp_path)
    ladder.step_deploy(tmp_path, "kl")
    (args,) = seen
    paths = {
        flag: Path(args[args.index(flag) + 1]) for flag in ("--artifacts", "--lock", "--models-dir")
    }
    assert paths == {
        "--artifacts": ML_ROOT / "artifacts",
        "--lock": REPO_ROOT / "contracts" / "models.lock.json",
        "--models-dir": REPO_ROOT / "firmware" / "models",
    }


def test_detection_holds_the_served_size_within_one_percent_of_q0() -> None:
    key = detection_quant.served_key()
    ceiling = {key: 0.95}
    assert detection_quant.gate({key: 0.9406}, ceiling)
    assert not detection_quant.gate({key: 0.9404}, ceiling)
    assert detection_quant.rank({key: 0.9}) == (0.9,)


def test_antispoof_holds_auc_blocks_every_attack_and_keeps_q0_s_real_faces() -> None:
    ceiling = {"real_kept": 61, "celeba_auc": 0.95}
    good = {"attacks_blocked": 25, "attacks": 25, "real_kept": 61, "celeba_auc": 0.9406}
    assert antispoof_quant.gate(good, ceiling)
    assert not antispoof_quant.gate({**good, "celeba_auc": 0.9404}, ceiling)
    assert not antispoof_quant.gate({**good, "attacks_blocked": 24}, ceiling)
    assert not antispoof_quant.gate({**good, "real_kept": 60}, ceiling)
    better_on_the_large_set = {**good, "celeba_auc": 0.95, "real_kept": 60}
    assert antispoof_quant.rank(better_on_the_large_set) > antispoof_quant.rank(good)


def test_antispoof_rates_are_read_at_the_kiosk_threshold() -> None:
    from facepipe.tasks.antispoof.losses.task_loss import LIVE

    floor = antispoof_quant.live_floor()
    fake = 1 - LIVE
    live = np.array([floor, floor - 0.01, floor - 0.2, floor + 0.2])
    truth = np.array([LIVE, LIVE, fake, fake])
    rates = antispoof_quant.rates_at_floor(live, truth)
    assert rates["n"] == 4
    assert rates["bpcer"] == pytest.approx(0.5)
    assert rates["apcer"] == pytest.approx(0.5)
    assert "auc" in rates
    only_attacks = antispoof_quant.rates_at_floor(live[2:], truth[2:])
    assert "auc" not in only_attacks and "bpcer" not in only_attacks


def test_a_set_of_shards_is_read_whole_or_folder_by_folder(tmp_path: Path) -> None:
    flat = tmp_path / "flat"
    flat.mkdir()
    (flat / "shard_00000.tar").write_bytes(b"")
    nested = tmp_path / "nested"
    for name in ("print", "bonafide", "empty"):
        (nested / name).mkdir(parents=True)
    (nested / "print" / "shard_00000.tar").write_bytes(b"")
    (nested / "bonafide" / "shard_00000.tar").write_bytes(b"")
    assert antispoof_quant.shard_specs(flat) == ["."]
    assert antispoof_quant.shard_specs(nested) == ["bonafide", "print"]
    with pytest.raises(FileNotFoundError):
        antispoof_quant.shard_specs(nested / "empty")


def test_a_row_scored_under_another_ruler_is_scored_again(tmp_path: Path, monkeypatch) -> None:
    scored: list[str] = []

    def score(_runner, _cfg):
        scored.append("x")
        return {"m": 0.9}

    hooks = SimpleNamespace(
        RULER="v2", score=score, headline=lambda m: "h", rank=lambda m: (m["m"],)
    )
    monkeypatch.setattr(ladder, "hooks_of", lambda _run: hooks)
    monkeypatch.setattr(ladder, "config_of", lambda _run: None)
    monkeypatch.setattr(
        ladder.tasks,
        "module_of",
        lambda _run, _name: SimpleNamespace(export_spec=lambda _run: (None, torch.nn.Identity())),
    )
    ladder.write_row(
        tmp_path, ladder.CEILING_ROW, {"rung": 0, "ruler": "v1", "metrics": {"m": 1.0}}
    )
    assert ladder.ceiling_of(tmp_path) == {"m": 0.9}
    assert ladder.ceiling_of(tmp_path) == {"m": 0.9}
    assert scored == ["x"]
    ladder.write_row(tmp_path, "kl", {"rung": 2, "ruler": "v1", "metrics": {"m": 0.95}})
    with pytest.raises(ValueError, match="no row of rung"):
        ladder.best_row(tmp_path, {2})


def test_the_choice_takes_a_faster_row_within_one_step_of_the_best(
    tmp_path: Path, monkeypatch
) -> None:
    hooks = SimpleNamespace(RESOLUTION=0.001, rank=lambda m: (m["m"],))
    monkeypatch.setattr(ladder, "hooks_of", lambda _run: hooks)
    rows = (
        ("kl", 0.9500, True, 300),
        ("mse", 0.9492, True, 290),
        ("int16_top4", 0.9530, True, 340),
        ("int16_top2", 0.9525, True, 310),
        ("minmax", 0.9600, False, 200),
    )
    for name, m, passes, ms in rows:
        ladder.write_row(
            tmp_path, name, {"rung": 2, "metrics": {"m": m}, "headline": name, "passes": passes}
        )
        log = ladder.row_dir(tmp_path, name) / "probe" / "models_0.log"
        log.parent.mkdir(parents=True)
        log.write_text(
            f"probe x: 8 frames, 0 of 9 values off, {ms * 1000} us mean, 1 us peak a frame\n"
        )
    assert ladder.step_choose(tmp_path) == 0
    assert ladder.board_ms(tmp_path, "int16_top2") == 310.0
    (ladder.row_dir(tmp_path, "int16_top2") / "probe" / "models_0.log").unlink()
    assert ladder.step_choose(tmp_path) == 1


def test_a_variant_carries_its_patches_and_a_plain_row_the_branch_s(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setattr(tasks, "branch_of", lambda _run: "recognition")
    branch = ptq_espdl.block("recognition")["esp_ppq_patches"]
    ladder.write_row(tmp_path, "kl", {"rung": 2, "metrics": {"m": 0.9}})
    patches = [*branch, "fused_prelu"]
    ladder.write_row(tmp_path, "kl+fused_prelu", {"rung": 2, "patches": patches})
    assert ladder.row_patches(tmp_path, "kl+fused_prelu") == patches
    assert ladder.row_patches(tmp_path, "kl") == branch
    assert ladder.row_patches(tmp_path, "timing") == branch


def test_variants_score_the_best_row_under_each_rounding_patch(tmp_path: Path, monkeypatch) -> None:
    knobs = {"esp_ppq_patches": ["cache_sized_convolutions"], "rounding_patches": ["fused_prelu"]}
    hooks = SimpleNamespace(rank=lambda m: (m["m"],))
    kept, simulated = {}, []
    monkeypatch.setattr(tasks, "branch_of", lambda _run: "recognition")
    monkeypatch.setattr(ptq_espdl, "block", lambda _branch: knobs)
    monkeypatch.setattr(ladder, "hooks_of", lambda _run: hooks)
    monkeypatch.setattr(ladder, "ceiling_of", lambda _run: {"m": 1.0})
    monkeypatch.setattr(export_espdl, "load_native", lambda path: path.parent.name)
    monkeypatch.setattr(
        ladder, "keep_row", lambda _run, row, graph, p: kept.update({row: (graph, p)})
    )
    monkeypatch.setattr(ptq_espdl, "Simulator", lambda graph, p: simulated.append((graph, p)))
    monkeypatch.setattr(
        ladder,
        "scored",
        lambda _run, _sim, _ceiling: {"metrics": {"m": 0.97}, "headline": "h", "passes": True},
    )
    ladder.write_row(tmp_path, "kl", {"rung": 2, "rungs": {"c": "kl"}, "metrics": {"m": 0.98}})
    ladder.write_row(tmp_path, "qat", {"rung": 4, "rungs": {"c": "kl"}, "metrics": {"m": 0.96}})
    ladder.step_variants(tmp_path)
    patches = ["cache_sized_convolutions", "fused_prelu"]
    assert kept == {"kl+fused_prelu": ("kl", patches)}
    assert simulated == [("kl", patches)]
    row = ladder.read_ladder(tmp_path)["kl+fused_prelu"]
    assert (row["rung"], row["base"], row["patches"], row["passes"]) == (2, "kl", patches, True)
    assert ladder.is_variant(row) and not ladder.is_variant(ladder.read_ladder(tmp_path)["kl"])


def test_timing_keeps_the_rows_its_rounding_patches_stack(tmp_path: Path, monkeypatch) -> None:
    knobs = {
        "esp_ppq_patches": ["cache_sized_convolutions"],
        "rounding_patches": ["fused_prelu", "prelu_on_input_grid"],
        "ladder": {"calib_samples": 4},
    }
    kept, rewrites = {}, []
    monkeypatch.setattr(tasks, "branch_of", lambda _run: "recognition")
    monkeypatch.setattr(ptq_espdl, "block", lambda _branch: knobs)
    monkeypatch.setattr(ptq_espdl, "timing_rungs", lambda _branch: {"c": "minmax"})
    monkeypatch.setattr(ptq_espdl, "calibration", lambda _run, n: list(range(n)))
    monkeypatch.setattr(ladder, "quantised", lambda _run, _rungs, calib: f"graph of {len(calib)}")
    monkeypatch.setattr(export_espdl, "load_native", lambda path: f"read {path.parent.name}")
    monkeypatch.setattr(
        esp_ppq_patches, "REWRITES", {"prelu_on_input_grid": lambda graph: rewrites.append(graph)}
    )
    monkeypatch.setattr(
        ladder, "keep_row", lambda _run, row, graph, p=None: kept.update({row: (graph, p)})
    )
    ladder.step_timing(tmp_path)
    one = ["cache_sized_convolutions", "fused_prelu"]
    two = [*one, "prelu_on_input_grid"]
    assert kept == {
        "timing": ("graph of 4", None),
        "timing+fused_prelu": ("read timing", one),
        "timing+fused_prelu+prelu_on_input_grid": ("read timing", two),
    }
    assert rewrites == ["read timing"]
    rows = ladder.read_ladder(tmp_path)
    assert "patches" not in rows["timing"]
    assert ladder.row_patches(tmp_path, "timing+fused_prelu+prelu_on_input_grid") == two


def test_recognition_embeds_a_benchmark_slice_by_slice_in_order(monkeypatch) -> None:
    import io

    from PIL import Image

    rng = np.random.default_rng(3)
    pixels = rng.integers(0, 256, size=(5, 4, 4, 3), dtype=np.uint8)
    encoded = []
    for image in pixels:
        buffer = io.BytesIO()
        Image.fromarray(image).save(buffer, format="PNG")
        encoded.append(buffer.getvalue())

    def runner(x: np.ndarray) -> list[np.ndarray]:
        return [x.reshape(len(x), -1)[:, :6]]

    runner.batched = True
    whole = recognition_quant.embeddings(runner, encoded, 4)
    monkeypatch.setattr(recognition_quant, "SCORE_SLICE", 2)
    assert np.array_equal(recognition_quant.embeddings(runner, encoded, 4), whole)
    want = ((pixels.astype(np.float32) - 127.5) / 127.5).transpose(0, 3, 1, 2)
    assert np.array_equal(whole, want.reshape(5, -1)[:, :6])


def test_antispoof_reads_live_from_the_softmax() -> None:
    live = antispoof_quant.live_scores(np.array([[0.0, 0.0], [10.0, -10.0]]), 0)
    assert live[0] == pytest.approx(0.5)
    assert live[1] == pytest.approx(1.0)


def test_recognition_holds_cfp_fp_within_one_percent_of_q0() -> None:
    ceiling = {"cfp_fp_tar3": 0.830}
    assert recognition_quant.gate({"cfp_fp_tar3": 0.822}, ceiling)
    assert not recognition_quant.gate({"cfp_fp_tar3": 0.756}, ceiling)
    metrics = {"lfw_acc": 0.9958, "lfw_tar3": 0.994, "lfw_tar4": 0.985}
    assert recognition_quant.headline(metrics) == "lfw 0.9958 / 0.994 / 0.985"


def test_the_firmware_constants_the_hooks_read_are_still_there() -> None:
    face_scale = ladder.firmware_constant(antispoof_quant.PREPROC_CPP, antispoof_quant.FACE_SCALE)
    live_min = ladder.firmware_constant(antispoof_quant.VISION_KCONFIG, antispoof_quant.LIVE_MIN)
    assert face_scale > 1.0
    assert 0 < live_min < 1000
