"""KEHOACH 3.7 rung 4: training moves the floats only, and carry lands them on the graph of one."""

from __future__ import annotations

from pathlib import Path

import pytest
import torch

from facepipe.compress.quant import ptq_espdl, qat_espdl
from tests.conftest import LadderNet, ladder_calibration, quantise_ladder_net


def wide_and_one(tmp_path: Path):
    """The same LadderNet quantised at batch 2 for training and at batch 1 for the chip."""
    pytest.importorskip("esp_ppq")
    torch.manual_seed(0)
    model = LadderNet().eval()
    rungs = ptq_espdl.timing_rungs("recognition")
    one_calib = ladder_calibration(count=4)
    wide_calib = [torch.cat(one_calib[i : i + 2]) for i in range(0, 4, 2)]
    wide = quantise_ladder_net(model, tmp_path / "wide", wide_calib, rungs)
    one = quantise_ladder_net(model, tmp_path / "one", one_calib, rungs)
    return wide, one, one_calib


def exponents(graph) -> list[int]:
    inputs, outputs = ptq_espdl.ports_of(graph)
    return [port.exponent for port in (*inputs, *outputs)]


def trained(graph, x: torch.Tensor) -> qat_espdl.Trainable:
    student = qat_espdl.Trainable(graph, "cpu")
    optimiser = torch.optim.Adam(student.parameters, lr=1e-2)
    for _ in range(3):
        loss = sum(out.square().mean() for out in student(x))
        optimiser.zero_grad()
        loss.backward()
        optimiser.step()
    student.freeze()
    return student


def test_training_moves_the_floats_and_keeps_every_exponent(tmp_path: Path) -> None:
    wide, _one, calib = wide_and_one(tmp_path)
    assert qat_espdl.batch_of(wide) == 2
    held = exponents(wide)
    before = {
        name: var.value.detach().clone() for name, var in qat_espdl.float_parameters(wide).items()
    }
    assert before
    student = trained(wide, torch.cat(calib[:2]))
    after = qat_espdl.float_parameters(wide)
    assert any(not torch.equal(before[name], after[name].value) for name in before)
    assert all(not t.requires_grad and t.grad is None for t in student.parameters)
    assert exponents(wide) == held


def test_carry_lands_the_training_on_the_graph_the_chip_runs(tmp_path: Path) -> None:
    wide, one, calib = wide_and_one(tmp_path)
    assert qat_espdl.batch_of(one) == 1
    trained(wide, torch.cat(calib[:2]))
    qat_espdl.carry(wide, one, calib[0].numpy())
    learnt = qat_espdl.float_parameters(wide)
    for name, var in qat_espdl.float_parameters(one).items():
        assert torch.equal(var.value, learnt[name].value.detach().cpu())
