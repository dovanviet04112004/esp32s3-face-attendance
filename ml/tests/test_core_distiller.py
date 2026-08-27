"""E2-T5: teacher stays frozen, hooks catch features, distilled loss goes down."""

from __future__ import annotations

import pytest
import torch
from torch import nn

from facepipe.core.config import DistillSection
from facepipe.core.distiller import Distiller, DistillLoss, DistillLossSet, TeacherWrapper
from facepipe.core.hooks import FeatureHooks, capture_features
from facepipe.core.registry import LOSSES


class KlLoss(DistillLoss):
    def __init__(self, temperature: float = 1.0):
        super().__init__()
        self.temperature = temperature

    def forward(self, student_out, teacher_out, batch=None, **_):
        t = self.temperature
        student = torch.log_softmax(student_out / t, dim=-1)
        teacher = torch.softmax(teacher_out / t, dim=-1)
        return nn.functional.kl_div(student, teacher, reduction="batchmean") * t * t


class FeatureLoss(DistillLoss):
    def forward(self, student_out, teacher_out, batch=None, student_features=None, **_):
        if not student_features:
            return torch.zeros((), device=student_out.device)
        return torch.stack([f.pow(2).mean() for f in student_features.values()]).mean()


@pytest.fixture(autouse=True)
def _register_losses():
    LOSSES.add("test_kl", KlLoss)
    LOSSES.add("test_feature", FeatureLoss)
    yield
    LOSSES._entries.pop("test_kl", None)
    LOSSES._entries.pop("test_feature", None)


def test_teacher_is_frozen_and_stays_in_eval(tiny_model) -> None:
    teacher = TeacherWrapper(tiny_model)
    assert all(not p.requires_grad for p in teacher.parameters())
    teacher.train()
    assert not teacher.model.training


def test_teacher_forward_produces_no_graph(tiny_model) -> None:
    teacher = TeacherWrapper(tiny_model)
    out = teacher(torch.randn(2, 1, 8, 8))
    assert out.grad_fn is None


def test_hooks_capture_named_layers(tiny_model) -> None:
    with capture_features(tiny_model, ["features.0"]) as hooks:
        tiny_model(torch.randn(2, 1, 8, 8))
        assert "features.0" in hooks.features
        assert hooks.features["features.0"].shape[0] == 2


def test_hooks_are_removed_on_exit(tiny_model) -> None:
    hooks = FeatureHooks(tiny_model, ["features.0"])
    with hooks:
        tiny_model(torch.randn(1, 1, 8, 8))
    assert hooks.features == {}
    tiny_model(torch.randn(1, 1, 8, 8))
    assert hooks.features == {}


def test_unknown_layer_is_reported(tiny_model) -> None:
    with pytest.raises(KeyError, match=r"features\.999"):
        FeatureHooks(tiny_model, ["features.999"])


def test_loss_set_weights_each_term() -> None:
    cfg = DistillSection(
        enabled=True,
        losses=[
            {"name": "test_kl", "weight": 2.0, "params": {"temperature": 2.0}},
            {"name": "test_feature", "weight": 0.0},
        ],
    )
    loss_set = DistillLossSet.from_config(cfg)
    student = torch.randn(4, 3, requires_grad=True)
    teacher = torch.randn(4, 3)
    total, parts = loss_set(student, teacher)
    assert set(parts) == {"test_kl", "test_feature"}
    assert total.requires_grad


def test_distilled_loss_decreases(tiny_model) -> None:
    from tests.conftest import TinyNet

    torch.manual_seed(0)
    teacher = TeacherWrapper(TinyNet(width=8))
    student = TinyNet(width=4)
    cfg = DistillSection(enabled=True, losses=[{"name": "test_kl", "weight": 1.0}])
    distiller = Distiller(student, teacher, DistillLossSet.from_config(cfg))
    optimizer = torch.optim.Adam(student.parameters(), lr=0.05)
    images = torch.randn(8, 1, 8, 8)

    first = last = None
    for step in range(40):
        loss, _ = distiller(images)
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        optimizer.step()
        if step == 0:
            first = float(loss.detach())
        last = float(loss.detach())
    assert last < first
    distiller.close()


def test_teacher_weights_do_not_move_during_distillation() -> None:
    from tests.conftest import TinyNet

    torch.manual_seed(0)
    teacher_net = TinyNet(width=8)
    before = teacher_net.head.weight.clone()
    teacher = TeacherWrapper(teacher_net)
    student = TinyNet(width=4)
    cfg = DistillSection(enabled=True, losses=[{"name": "test_kl", "weight": 1.0}])
    distiller = Distiller(student, teacher, DistillLossSet.from_config(cfg))
    optimizer = torch.optim.Adam(distiller.parameters(), lr=0.1)
    for _ in range(5):
        loss, _ = distiller(torch.randn(4, 1, 8, 8))
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        optimizer.step()
    assert torch.allclose(teacher_net.head.weight, before)
    distiller.close()


def test_without_teacher_only_the_task_loss_runs() -> None:
    from tests.conftest import TinyNet

    student = TinyNet()
    task = lambda out, batch: out.pow(2).mean()  # noqa: E731
    distiller = Distiller(student, teacher=None, loss_set=None, task_loss=task)
    assert not distiller.distilling
    total, parts = distiller(torch.randn(4, 1, 8, 8))
    assert set(parts) == {"task", "total"}
    assert total.requires_grad


def test_no_loss_at_all_is_an_error() -> None:
    from tests.conftest import TinyNet

    distiller = Distiller(TinyNet(), teacher=None, loss_set=None, task_loss=None)
    with pytest.raises(ValueError, match="nothing to optimize"):
        distiller(torch.randn(2, 1, 8, 8))
