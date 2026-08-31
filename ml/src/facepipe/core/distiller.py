"""Teacher wrapping and distillation loss composition.

Core knows that a teacher produces something and that losses consume it. What
those outputs mean is the branch's business: logits, depth maps and embeddings
all pass through unchanged.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

import torch
from torch import nn

from facepipe.core.config import DistillSection, StageSpec
from facepipe.core.hooks import FeatureHooks
from facepipe.core.registry import LOSSES


class TeacherWrapper(nn.Module):
    """A frozen teacher that never contributes gradients.

    Freezing is enforced on every forward, not only at construction: an outer
    call to model.train() would otherwise put batch-norm back into update mode
    and let the teacher drift mid-run.
    """

    def __init__(self, model: nn.Module, freeze: bool = True) -> None:
        super().__init__()
        self.model = model
        self.freeze = freeze
        if freeze:
            for param in self.model.parameters():
                param.requires_grad_(False)
        self.model.eval()

    def train(self, mode: bool = True) -> TeacherWrapper:
        super().train(mode)
        if self.freeze:
            self.model.eval()
        return self

    @torch.no_grad()
    def forward(self, *args: Any, **kwargs: Any) -> Any:
        return self.model(*args, **kwargs)


class DistillLoss(ABC, nn.Module):
    """One distillation term.

    Implementations live in tasks/<branch>/losses/ and register themselves under
    a name the config can select.
    """

    @abstractmethod
    def forward(
        self,
        student_out: Any,
        teacher_out: Any,
        batch: Any = None,
        student_features: Mapping[str, torch.Tensor] | None = None,
        teacher_features: Mapping[str, torch.Tensor] | None = None,
    ) -> torch.Tensor:
        """Return a scalar loss."""


@dataclass
class LossTerm:
    name: str
    weight: float
    fn: nn.Module


class StageSchedule:
    """Which distillation terms are live at a given epoch.

    Turning every term on at once lets the task loss pull the student towards
    the labels before it has learned anything from the teacher's features, and
    the feature term then spends the run fighting it (KEHOACH section 3, layer 2).
    An empty schedule means every term is always on.
    """

    def __init__(self, stages: list[StageSpec]) -> None:
        self.stages = stages
        self.boundaries: list[int] = []
        total = 0
        for stage in stages:
            total += stage.epochs
            self.boundaries.append(total)

    def at(self, epoch: int) -> StageSpec | None:
        for boundary, stage in zip(self.boundaries, self.stages, strict=True):
            if epoch < boundary:
                return stage
        return self.stages[-1] if self.stages else None


class DistillLossSet(nn.Module):
    """Weighted sum of distillation terms, reported per term."""

    def __init__(self, terms: list[LossTerm]) -> None:
        super().__init__()
        self.terms = terms
        self._modules_holder = nn.ModuleList([t.fn for t in terms])

    @classmethod
    def from_config(cls, cfg: DistillSection) -> DistillLossSet:
        """Build every term named in the config through the loss registry."""
        terms = [
            LossTerm(name=spec.name, weight=spec.weight, fn=LOSSES.build(spec.model_dump()))
            for spec in cfg.losses
        ]
        return cls(terms)

    def forward(
        self,
        student_out: Any,
        teacher_out: Any,
        batch: Any = None,
        student_features: Mapping[str, torch.Tensor] | None = None,
        teacher_features: Mapping[str, torch.Tensor] | None = None,
        only: set[str] | None = None,
    ) -> tuple[torch.Tensor, dict[str, torch.Tensor]]:
        total: torch.Tensor | None = None
        parts: dict[str, torch.Tensor] = {}
        for term in self.terms:
            if only is not None and term.name not in only:
                continue
            value = term.fn(
                student_out,
                teacher_out,
                batch,
                student_features=student_features,
                teacher_features=teacher_features,
            )
            parts[term.name] = value.detach()
            scaled = value * term.weight
            total = scaled if total is None else total + scaled
        if total is None:
            total = torch.zeros((), device=_device_of(student_out))
        return total, parts


def _device_of(value: Any) -> torch.device:
    if isinstance(value, torch.Tensor):
        return value.device
    if isinstance(value, Mapping):
        for item in value.values():
            if isinstance(item, torch.Tensor):
                return item.device
    if isinstance(value, tuple | list):
        for item in value:
            if isinstance(item, torch.Tensor):
                return item.device
    return torch.device("cpu")


class Distiller(nn.Module):
    """Runs student and teacher together and combines task and distill losses.

    With distillation disabled the teacher is never constructed and the object
    degrades to the task loss, so one training loop serves all four arms of the
    ablation table in section 3.7.
    """

    def __init__(
        self,
        student: nn.Module,
        teacher: TeacherWrapper | None,
        loss_set: DistillLossSet | None,
        task_loss: nn.Module | None = None,
        task_loss_weight: float = 1.0,
        student_layers: list[str] | None = None,
        teacher_layers: list[str] | None = None,
        schedule: StageSchedule | None = None,
    ) -> None:
        super().__init__()
        self.student = student
        self.teacher = teacher
        self.loss_set = loss_set
        self.task_loss = task_loss
        self.task_loss_weight = task_loss_weight
        self.schedule = schedule
        self.epoch = 0
        self._student_hooks = (
            FeatureHooks(student, student_layers).attach() if student_layers else None
        )
        self._teacher_hooks = (
            FeatureHooks(teacher, teacher_layers, detach=True).attach()
            if teacher is not None and teacher_layers
            else None
        )

    @property
    def distilling(self) -> bool:
        return self.teacher is not None and self.loss_set is not None

    def forward(
        self, inputs: Any, batch: Any = None
    ) -> tuple[torch.Tensor, dict[str, torch.Tensor]]:
        """Return the total loss and a per-term report."""
        self._clear_hooks()
        student_out = self.student(inputs)
        parts: dict[str, torch.Tensor] = {}
        total: torch.Tensor | None = None

        stage = self.schedule.at(self.epoch) if self.schedule is not None else None
        task_weight = self.task_loss_weight if stage is None else stage.task_loss_weight
        active = set(stage.losses) if stage is not None else None

        if self.task_loss is not None:
            task_value = self.task_loss(student_out, batch)
            parts["task"] = task_value.detach()
            total = task_value * task_weight

        if self.distilling:
            teacher_out = self.teacher(self.teacher_inputs(inputs, batch))
            distill_value, distill_parts = self.loss_set(
                student_out,
                teacher_out,
                batch,
                student_features=self._features(self._student_hooks),
                teacher_features=self._features(self._teacher_hooks),
                only=active,
            )
            parts.update({f"kd_{k}": v for k, v in distill_parts.items()})
            total = distill_value if total is None else total + distill_value

        if total is None:
            raise ValueError("no task loss and no distillation loss: nothing to optimize")
        parts["total"] = total.detach()
        return total, parts

    def teacher_inputs(self, inputs: Any, batch: Any) -> Any:
        """What the teacher is called with. Override to feed it something else.

        A teacher whose answers were precomputed is handed those answers rather
        than the images they came from, and only the branch that has such a
        teacher knows where in the batch they travel.
        """
        return inputs

    def _clear_hooks(self) -> None:
        for hooks in (self._student_hooks, self._teacher_hooks):
            if hooks is not None:
                hooks.clear()

    @staticmethod
    def _features(hooks: FeatureHooks | None) -> dict[str, torch.Tensor] | None:
        return hooks.features if hooks is not None else None

    def close(self) -> None:
        """Remove feature hooks."""
        for hooks in (self._student_hooks, self._teacher_hooks):
            if hooks is not None:
                hooks.remove()
