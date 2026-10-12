"""KEHOACH 3.7 rungs 1-2: quant.yaml reaches ESP-PPQ intact and the integers come back whole."""

from __future__ import annotations

import copy
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pytest
import torch

from facepipe.compress.quant import esp_ppq_patches, ptq_espdl
from tests.conftest import LadderNet, ladder_calibration, quantise_ladder_net

BRANCHES = ("detection", "antispoof", "recognition")


def test_every_branch_climbs_from_the_default_rungs() -> None:
    default = ptq_espdl.load_ladder()["default"]
    for branch in BRANCHES:
        assert set(ptq_espdl.ladder(branch)) == set(default)
        block = ptq_espdl.block(branch)
        assert {"rungs", "ladder", "esp_ppq_patches", "probe", "chosen"} <= set(block)
        assert set(block["esp_ppq_patches"]) <= set(esp_ppq_patches.PATCHES)
        assert sorted(block["ladder"]["calibrations"]) == ["kl", "minmax", "mse", "percentile"]


def test_the_timing_row_drops_what_only_costs_host_time() -> None:
    for branch in BRANCHES:
        rungs = ptq_espdl.timing_rungs(branch)
        assert rungs["equalization"] is None
        assert rungs["bias_correction"] is False
        assert rungs["calibration"] == "minmax"
        assert rungs["int16_ops"] == ptq_espdl.ladder(branch)["int16_ops"]


def test_the_setting_carries_every_rung() -> None:
    pytest.importorskip("esp_ppq")
    from esp_ppq.api.espdl_interface import get_target_platform

    rungs = {
        **ptq_espdl.ladder("recognition"),
        "calibration": "percentile",
        "int16_ops": ["/a/Conv"],
    }
    setting = ptq_espdl.setting_of(rungs)
    assert setting.equalization is True
    assert setting.equalization_setting.iterations == rungs["equalization"]["iterations"]
    assert setting.equalization_setting.value_threshold == rungs["equalization"]["value_threshold"]
    assert setting.equalization_setting.opt_level == rungs["equalization"]["opt_level"]
    assert setting.bias_correct is True
    assert setting.quantize_activation_setting.calib_algorithm == "percentile"
    wide = get_target_platform(ptq_espdl.TARGET, ptq_espdl.WIDE_BITS).value
    assert setting.dispatching_table.dispatchings["/a/Conv"] == wide

    timing = ptq_espdl.setting_of(ptq_espdl.timing_rungs("recognition"))
    assert timing.equalization is False
    assert timing.bias_correct is False
    assert timing.quantize_activation_setting.calib_algorithm == "minmax"


def test_an_exponent_is_a_power_of_two_or_nothing() -> None:
    assert ptq_espdl.exponent_of(SimpleNamespace(scale=torch.tensor(0.125))) == -3
    assert ptq_espdl.exponent_of(SimpleNamespace(scale=torch.tensor(4.0))) == 2
    with pytest.raises(ValueError, match="power of two"):
        ptq_espdl.exponent_of(SimpleNamespace(scale=torch.tensor(0.1)))


def test_int8_rounds_to_even_and_saturates() -> None:
    steps = np.array([0.5, 1.5, -0.5, -2.5, 300.0, -300.0], dtype=np.float32)
    got = ptq_espdl.to_int8(steps * np.float32(2.0**-3), -3)
    assert got.dtype == np.int8
    assert got.tolist() == [0, 2, 0, -2, 127, -128]


def test_the_simulation_lands_on_every_output_grid(ladder_graph) -> None:
    (port, *rest), outputs = ptq_espdl.ports_of(ladder_graph.graph)
    assert not rest
    assert port.name == "image"
    assert [out.name for out in outputs] == ["vector", "map"]
    simulator = ptq_espdl.Simulator(ladder_graph.graph, device="cpu")
    for x in ladder_graph.calib[:3]:
        got = simulator(x.numpy())
        assert [y.shape for y in got] == [(1, 8), (1, 16, 8, 8)]
        for out, y in zip(outputs, got, strict=True):
            on_grid = ptq_espdl.to_int8(y, out.exponent).astype(np.float32) * 2.0**out.exponent
            assert np.array_equal(on_grid.astype(np.float32), y)
    assert ptq_espdl.port_bits(ladder_graph.graph) == {ptq_espdl.BITS}


def test_a_wide_layer_at_an_end_shows_in_the_port_bits(ladder_graph, tmp_path: Path) -> None:
    graph = ladder_graph.graph
    head = graph.variables["vector"].source_op.name
    rungs = {**ptq_espdl.timing_rungs("recognition"), "int16_ops": [head]}
    wide = quantise_ladder_net(ladder_graph.model, tmp_path, ladder_graph.calib, rungs)
    assert ptq_espdl.port_bits(wide) == {ptq_espdl.BITS, ptq_espdl.WIDE_BITS}


def exported_as_given(run, out: Path, feed: torch.Tensor, rtol: float, model=None) -> Path:
    torch.onnx.export(
        model.eval(),
        (feed,),
        str(out),
        opset_version=13,
        input_names=["image"],
        output_names=["vector", "map"],
        dynamo=False,
    )
    return out


def test_a_rewrite_that_keeps_the_arithmetic_keeps_every_integer(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    pytest.importorskip("esp_ppq")
    monkeypatch.setattr(ptq_espdl, "export_onnx", exported_as_given)
    torch.manual_seed(0)
    model = LadderNet().eval()
    calib = ladder_calibration(count=4)
    inputs = [x.numpy() for x in ladder_calibration(count=2, seed=7)]
    rungs = ptq_espdl.timing_rungs("recognition")
    same = copy.deepcopy(model)
    assert ptq_espdl.same_integers(tmp_path, [model, same], calib, inputs, rungs, []) == (0, 0.0)

    nudged = copy.deepcopy(model)
    with torch.no_grad():
        nudged.body.weight.mul_(1.5)
    off, worst = ptq_espdl.same_integers(tmp_path, [model, nudged], calib, inputs, rungs, [])
    assert off > 0
    assert worst > 0.0


def test_a_second_import_leaves_the_registry_alone() -> None:
    from facepipe.core import registry

    kept = registry.Registry.register
    models = registry.Registry("probe")
    with ptq_espdl.unregistered():

        @models.register("shadow")
        class Shadow:
            pass

        assert Shadow.__name__ == "Shadow"
    assert registry.Registry.register is kept
    with pytest.raises(registry.RegistryError):
        models.get("shadow")
