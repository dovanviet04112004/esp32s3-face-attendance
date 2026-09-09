"""E2-T4 and E2-T7: the loop trains, survives an interrupt, and repeats on a seed."""

from __future__ import annotations

import copy
from pathlib import Path

import pytest
import torch
from torch import nn
from torch.utils.data import DataLoader

from facepipe.core.config import Config, load_config
from facepipe.core.logger import RunLogger
from facepipe.core.run_dir import RunDir, create_run_dir
from facepipe.core.scheduler import build_optimizer, build_scheduler
from facepipe.core.seed import seed_everything
from facepipe.core.trainer import CKPT_LAST, RESUMED_FROM_NAME, ModelEma, Trainer


class InterruptError(RuntimeError):
    """Stand-in for the user hitting Ctrl-C mid-epoch."""


def _build(
    cfg: Config, run: RunDir, model: nn.Module, loader: DataLoader, stop_at: int | None = None
) -> Trainer:
    optimizer = build_optimizer(model, cfg.optim)
    scheduler = build_scheduler(optimizer, cfg.sched, len(loader), cfg.train.epochs)
    criterion = nn.CrossEntropyLoss()
    logger = RunLogger(run.path, tensorboard=False, level="WARNING")

    def step_fn(batch):
        images, labels = batch
        loss = criterion(model(images), labels)
        return loss, {"loss": float(loss.detach())}

    trainer = Trainer(
        model=model,
        optimizer=optimizer,
        scheduler=scheduler,
        train_loader=loader,
        cfg=cfg,
        run_dir=run,
        logger=logger,
        step_fn=step_fn,
    )
    if stop_at is not None:
        trainer.step_fn = _stopping(step_fn, trainer, stop_at)
    return trainer


def _stopping(step_fn, trainer: Trainer, stop_at: int):
    def wrapped(batch):
        if trainer.state.global_step >= stop_at:
            raise InterruptError(f"stopped at step {stop_at}")
        return step_fn(batch)

    return wrapped


def _cfg(config_file: Path, tmp_path: Path, *overrides: str) -> Config:
    return load_config(config_file, [f"run.artifacts_root={tmp_path / 'a'}", *overrides])


def test_trains_two_epochs(config_file, tmp_path, tiny_model, tiny_loader) -> None:
    cfg = _cfg(config_file, tmp_path)
    run = create_run_dir(cfg)
    trainer = _build(cfg, run, tiny_model, tiny_loader)
    state = trainer.fit()
    assert state.epoch == 2
    assert state.global_step == 2 * len(tiny_loader)
    assert (run.ckpt_dir / CKPT_LAST).is_file()


def test_resume_continues_at_the_same_step(config_file, tmp_path, tiny_loader) -> None:
    cfg = _cfg(config_file, tmp_path)
    seed_everything(cfg.run.seed, deterministic=True)

    from tests.conftest import TinyNet

    steps_per_epoch = len(tiny_loader)
    first = create_run_dir(cfg)
    trainer = _build(cfg, first, TinyNet(), tiny_loader, stop_at=steps_per_epoch + 2)
    with pytest.raises(InterruptError):
        trainer.fit()

    resumed_cfg = _cfg(config_file, tmp_path, f"train.resume={first.ckpt_dir / CKPT_LAST}")
    second = create_run_dir(resumed_cfg)
    resumed = _build(resumed_cfg, second, TinyNet(), tiny_loader)
    assert resumed.state.epoch == 1
    assert resumed.state.global_step == steps_per_epoch

    state = resumed.fit()
    assert state.epoch == 2
    assert state.global_step == 2 * steps_per_epoch


def test_resume_restores_weights_exactly(config_file, tmp_path, tiny_loader) -> None:
    from tests.conftest import TinyNet

    cfg = _cfg(config_file, tmp_path)
    run = create_run_dir(cfg)
    trainer = _build(cfg, run, TinyNet(), tiny_loader)
    trainer.fit()
    saved = {k: v.clone() for k, v in trainer.model.state_dict().items()}

    resumed_cfg = _cfg(config_file, tmp_path, f"train.resume={run.ckpt_dir / CKPT_LAST}")
    resumed = _build(resumed_cfg, create_run_dir(resumed_cfg), TinyNet(), tiny_loader)
    for key, value in saved.items():
        assert torch.allclose(resumed.model.state_dict()[key], value), key


class CentresInLoss(nn.Module):
    """A classifier the optimizer owns but the exported model never contains.

    ArcFace puts its per-identity centres here, and they outweigh the model
    they are trained beside (KEHOACH 4.4).
    """

    def __init__(self, features: int = 2, classes: int = 3) -> None:
        super().__init__()
        self.centres = nn.Parameter(torch.randn(classes, features))

    def forward(self, logits: torch.Tensor, labels: torch.Tensor) -> torch.Tensor:
        return nn.functional.cross_entropy(logits @ self.centres.t(), labels)


def _build_with_centres(cfg: Config, run: RunDir, model: nn.Module, centres: nn.Module, loader):
    optimizer = build_optimizer(nn.ModuleList([model, centres]), cfg.optim)
    scheduler = build_scheduler(optimizer, cfg.sched, len(loader), cfg.train.epochs)

    def step_fn(batch):
        images, labels = batch
        loss = centres(model(images), labels)
        return loss, {"loss": float(loss.detach())}

    return Trainer(
        model=model,
        optimizer=optimizer,
        scheduler=scheduler,
        train_loader=loader,
        cfg=cfg,
        run_dir=run,
        logger=RunLogger(run.path, tensorboard=False, level="WARNING"),
        step_fn=step_fn,
        trained_elsewhere={"centres": centres},
    )


def test_resume_restores_parameters_the_model_does_not_hold(
    config_file, tmp_path, tiny_loader
) -> None:
    """The bug this guards: a head living in the loss came back randomly seeded,
    while its momentum came back trained, so the resumed arm relearned it."""
    from tests.conftest import TinyNet

    cfg = _cfg(config_file, tmp_path)
    run = create_run_dir(cfg)
    trained = CentresInLoss()
    _build_with_centres(cfg, run, TinyNet(), trained, tiny_loader).fit()
    saved = trained.centres.detach().clone()

    resumed_cfg = _cfg(config_file, tmp_path, f"train.resume={run.ckpt_dir / CKPT_LAST}")
    fresh = CentresInLoss()
    assert not torch.allclose(fresh.centres, saved)
    _build_with_centres(resumed_cfg, create_run_dir(resumed_cfg), TinyNet(), fresh, tiny_loader)
    assert torch.allclose(fresh.centres, saved)


def test_resume_refuses_a_checkpoint_missing_those_parameters(
    config_file, tmp_path, tiny_loader
) -> None:
    """Silence here is what let a run train for hours on a randomly seeded head."""
    from tests.conftest import TinyNet

    cfg = _cfg(config_file, tmp_path)
    run = create_run_dir(cfg)
    trainer = _build(cfg, run, TinyNet(), tiny_loader)
    trainer.fit()

    resumed_cfg = _cfg(config_file, tmp_path, f"train.resume={run.ckpt_dir / CKPT_LAST}")
    with pytest.raises(ValueError, match="centres"):
        _build_with_centres(
            resumed_cfg, create_run_dir(resumed_cfg), TinyNet(), CentresInLoss(), tiny_loader
        )


def test_resume_puts_optimizer_state_beside_its_parameters(
    config_file, tmp_path, tiny_loader
) -> None:
    """Momentum is cast to wherever a parameter sits when the state is restored."""
    from tests.conftest import TinyNet

    cfg = _cfg(config_file, tmp_path)
    run = create_run_dir(cfg)
    _build_with_centres(cfg, run, TinyNet(), CentresInLoss(), tiny_loader).fit()

    resumed_cfg = _cfg(config_file, tmp_path, f"train.resume={run.ckpt_dir / CKPT_LAST}")
    resumed = _build_with_centres(
        resumed_cfg, create_run_dir(resumed_cfg), TinyNet(), CentresInLoss(), tiny_loader
    )
    for group in resumed.optimizer.param_groups:
        for param in group["params"]:
            for value in resumed.optimizer.state.get(param, {}).values():
                if torch.is_tensor(value):
                    assert value.device == param.device


def test_same_seed_gives_the_same_loss(config_file, tmp_path, tiny_loader) -> None:
    from tests.conftest import TinyNet

    losses = []
    for index in range(2):
        cfg = _cfg(config_file, tmp_path, f"run.task=seedrun{index}")
        seed_everything(cfg.run.seed, deterministic=True)
        trainer = _build(cfg, create_run_dir(cfg), TinyNet(), tiny_loader)
        state = trainer.fit()
        losses.append(state.history[-1]["loss"])
    assert losses[0] == pytest.approx(losses[1], rel=1e-9, abs=1e-9)


def test_different_seed_gives_a_different_loss(config_file, tmp_path, tiny_loader) -> None:
    from tests.conftest import TinyNet

    losses = []
    for index, seed in enumerate((1, 2)):
        cfg = _cfg(config_file, tmp_path, f"run.task=seedvary{index}", f"run.seed={seed}")
        seed_everything(cfg.run.seed, deterministic=True)
        trainer = _build(cfg, create_run_dir(cfg), TinyNet(), tiny_loader)
        losses.append(trainer.fit().history[-1]["loss"])
    assert losses[0] != pytest.approx(losses[1])


def test_grad_accumulation_reduces_optimizer_steps(config_file, tmp_path, tiny_loader) -> None:
    from tests.conftest import TinyNet

    cfg = _cfg(config_file, tmp_path, "train.accum_steps=2", "train.epochs=1")
    trainer = _build(cfg, create_run_dir(cfg), TinyNet(), tiny_loader)
    state = trainer.fit()
    assert state.global_step == len(tiny_loader) // 2


def test_non_finite_loss_stops_the_run(config_file, tmp_path, tiny_loader) -> None:
    from tests.conftest import TinyNet

    cfg = _cfg(config_file, tmp_path)
    run = create_run_dir(cfg)
    model = TinyNet()
    trainer = _build(cfg, run, model, tiny_loader)
    trainer.step_fn = lambda batch: (torch.tensor(float("nan"), requires_grad=True), {"loss": 0.0})
    with pytest.raises(FloatingPointError, match="non-finite"):
        trainer.fit()


def test_ema_tracks_but_lags_the_live_weights(tiny_model) -> None:
    ema = ModelEma(tiny_model, decay=0.5)
    before = ema.module.head.weight.clone()
    with torch.no_grad():
        tiny_model.head.weight.add_(1.0)
    ema.update(tiny_model)
    after = ema.module.head.weight
    assert not torch.allclose(after, before)
    assert not torch.allclose(after, tiny_model.head.weight)


def test_ema_matches_the_tensor_by_tensor_average_exactly(tiny_model) -> None:
    """Fusing the update must not move a single bit of the arithmetic.

    Reference is the plain formula applied one tensor at a time, over several
    steps so any drift between the two has somewhere to accumulate.
    """
    decay = 0.9
    ema = ModelEma(tiny_model, decay=decay)
    reference = {k: v.clone() for k, v in ema.module.state_dict().items()}

    for step in range(5):
        with torch.no_grad():
            tiny_model.head.weight.add_(0.1 * (step + 1))
        ema.update(tiny_model)
        for key, value in tiny_model.state_dict().items():
            if reference[key].dtype.is_floating_point:
                reference[key].mul_(decay).add_(value, alpha=1.0 - decay)
            else:
                reference[key].copy_(value)

    for key, value in ema.module.state_dict().items():
        assert torch.equal(value, reference[key]), key


def test_ema_keeps_tracking_after_the_model_object_is_swapped(tiny_model) -> None:
    """The trainer hands over a compiled wrapper, and the pairing is cached."""
    ema = ModelEma(tiny_model, decay=0.5)
    ema.update(tiny_model)
    replacement = copy.deepcopy(tiny_model)
    with torch.no_grad():
        replacement.head.weight.fill_(7.0)

    ema.update(replacement)
    ema.update(replacement)
    target = torch.full_like(ema.module.head.weight, 7.0)
    assert torch.allclose(ema.module.head.weight, target, atol=2.0)
    assert not torch.allclose(ema.module.head.weight, tiny_model.head.weight)


def test_ema_state_survives_a_round_trip(tiny_model) -> None:
    ema = ModelEma(tiny_model, decay=0.9)
    with torch.no_grad():
        tiny_model.head.weight.add_(0.3)
    ema.update(tiny_model)
    restored = ModelEma(tiny_model, decay=0.1)
    restored.load_state_dict(ema.state_dict())
    assert restored.decay == pytest.approx(0.9)
    assert torch.allclose(restored.module.head.weight, ema.module.head.weight)


def test_resume_records_the_run_it_continued(config_file, tmp_path, tiny_loader) -> None:
    from tests.conftest import TinyNet

    cfg = _cfg(config_file, tmp_path)
    first = create_run_dir(cfg)
    _build(cfg, first, TinyNet(), tiny_loader).fit()

    resumed_cfg = _cfg(config_file, tmp_path, f"train.resume={first.ckpt_dir / CKPT_LAST}")
    second = create_run_dir(resumed_cfg)
    resumed = _build(resumed_cfg, second, TinyNet(), tiny_loader)

    assert resumed.resumed_from == first.run_id
    lineage = second.path / RESUMED_FROM_NAME
    assert lineage.read_text(encoding="utf-8").strip() == first.run_id


def test_a_fresh_run_claims_no_parent(config_file, tmp_path, tiny_loader) -> None:
    from tests.conftest import TinyNet

    cfg = _cfg(config_file, tmp_path)
    run = create_run_dir(cfg)
    trainer = _build(cfg, run, TinyNet(), tiny_loader)
    assert trainer.resumed_from is None
    assert not (run.path / RESUMED_FROM_NAME).exists()


class PrefixWrapper(nn.Module):
    """Stands in for torch.compile, which renames state_dict keys."""

    def __init__(self, wrapped: nn.Module) -> None:
        super().__init__()
        self._orig_mod = wrapped

    def forward(self, *args, **kwargs):
        return self._orig_mod(*args, **kwargs)


def test_a_compiled_run_checkpoints_the_module_underneath(
    monkeypatch, config_file, tmp_path, tiny_model, tiny_loader
) -> None:
    monkeypatch.setattr(torch, "compile", lambda m, **kw: PrefixWrapper(m))
    cfg = _cfg(config_file, tmp_path, "train.compile=true")
    run = create_run_dir(cfg)
    trainer = _build(cfg, run, tiny_model, tiny_loader)

    assert isinstance(trainer.model, PrefixWrapper)
    assert trainer.module is tiny_model
    trainer.fit()

    saved = torch.load(run.ckpt_dir / CKPT_LAST, map_location="cpu", weights_only=False)
    assert not any(k.startswith("_orig_mod.") for k in saved["model"])
    assert set(saved["model"]) == set(tiny_model.state_dict())


def test_compile_off_leaves_the_model_unwrapped(config_file, tmp_path, tiny_model, tiny_loader):
    cfg = _cfg(config_file, tmp_path)
    trainer = _build(cfg, create_run_dir(cfg), tiny_model, tiny_loader)
    assert trainer.model is trainer.module is tiny_model


def test_a_non_finite_loss_stops_the_run(config_file, tmp_path, tiny_model, tiny_loader) -> None:
    cfg = _cfg(config_file, tmp_path, "train.epochs=1")
    run = create_run_dir(cfg)
    trainer = _build(cfg, run, tiny_model, tiny_loader)
    trainer.step_fn = lambda batch: (torch.tensor(float("nan"), requires_grad=True), {})
    with pytest.raises(FloatingPointError):
        trainer.fit()


def test_resume_into_a_compiled_run_restores_the_weights(
    monkeypatch, config_file, tmp_path, tiny_loader
) -> None:
    from tests.conftest import TinyNet

    monkeypatch.setattr(torch, "compile", lambda m, **kw: PrefixWrapper(m))
    cfg = _cfg(config_file, tmp_path, "train.compile=true")
    run = create_run_dir(cfg)
    trainer = _build(cfg, run, TinyNet(), tiny_loader)
    trainer.fit()
    saved = {k: v.clone() for k, v in trainer.module.state_dict().items()}

    resumed_cfg = _cfg(
        config_file, tmp_path, "train.compile=true", f"train.resume={run.ckpt_dir / CKPT_LAST}"
    )
    resumed = _build(resumed_cfg, create_run_dir(resumed_cfg), TinyNet(), tiny_loader)
    assert isinstance(resumed.model, PrefixWrapper)
    for key, value in saved.items():
        assert torch.allclose(resumed.module.state_dict()[key], value), key


class LossHoldingTheModel(nn.Module):
    """The training bundle's shape: it runs the model and owns centres beside it.

    A compiled run points this at the wrapper so the loss reaches the compiled
    graph, which is what puts the prefix into its state_dict (KEHOACH 4.4).
    """

    def __init__(self, model: nn.Module, features: int = 2, classes: int = 3) -> None:
        super().__init__()
        self.model = model
        self.centres = nn.Parameter(torch.randn(classes, features))

    def forward(self, images: torch.Tensor, labels: torch.Tensor) -> torch.Tensor:
        return nn.functional.cross_entropy(self.model(images) @ self.centres.t(), labels)


def _build_holding_model(cfg: Config, run: RunDir, model: nn.Module, loader):
    holder = LossHoldingTheModel(model)
    optimizer = build_optimizer(holder, cfg.optim)
    trainer = Trainer(
        model=model,
        optimizer=optimizer,
        scheduler=build_scheduler(optimizer, cfg.sched, len(loader), cfg.train.epochs),
        train_loader=loader,
        cfg=cfg,
        run_dir=run,
        logger=RunLogger(run.path, tensorboard=False, level="WARNING"),
        step_fn=lambda batch: (holder(*batch), {}),
        trained_elsewhere={"holder": holder},
    )
    holder.model = trainer.model
    return trainer, holder


def test_a_compiled_run_keeps_the_prefix_out_of_elsewhere(
    monkeypatch, config_file, tmp_path, tiny_loader
) -> None:
    """The bug this guards: the loss was checkpointed through the compiled
    wrapper but read back through the bare model, so no key ever matched."""
    from tests.conftest import TinyNet

    monkeypatch.setattr(torch, "compile", lambda m, **kw: PrefixWrapper(m))
    cfg = _cfg(config_file, tmp_path, "train.compile=true")
    run = create_run_dir(cfg)
    trainer, holder = _build_holding_model(cfg, run, TinyNet(), tiny_loader)
    assert isinstance(holder.model, PrefixWrapper)
    trainer.fit()

    stored = torch.load(run.ckpt_dir / CKPT_LAST, map_location="cpu", weights_only=False)
    assert not any("_orig_mod." in key for key in stored["elsewhere"]["holder"])


def test_a_compiled_checkpoint_resumes_into_the_loss(
    monkeypatch, config_file, tmp_path, tiny_loader
) -> None:
    from tests.conftest import TinyNet

    monkeypatch.setattr(torch, "compile", lambda m, **kw: PrefixWrapper(m))
    cfg = _cfg(config_file, tmp_path, "train.compile=true")
    run = create_run_dir(cfg)
    trainer, holder = _build_holding_model(cfg, run, TinyNet(), tiny_loader)
    trainer.fit()
    saved = holder.centres.detach().clone()

    resumed_cfg = _cfg(
        config_file, tmp_path, "train.compile=true", f"train.resume={run.ckpt_dir / CKPT_LAST}"
    )
    _, fresh = _build_holding_model(
        resumed_cfg, create_run_dir(resumed_cfg), TinyNet(), tiny_loader
    )
    assert torch.allclose(fresh.centres, saved)


def test_an_uncompiled_run_can_resume_a_compiled_checkpoint(
    monkeypatch, config_file, tmp_path, tiny_loader
) -> None:
    """Compiling is a runtime choice, so it must not fence off a checkpoint."""
    from tests.conftest import TinyNet

    monkeypatch.setattr(torch, "compile", lambda m, **kw: PrefixWrapper(m))
    cfg = _cfg(config_file, tmp_path, "train.compile=true")
    run = create_run_dir(cfg)
    trainer, holder = _build_holding_model(cfg, run, TinyNet(), tiny_loader)
    trainer.fit()
    saved = holder.centres.detach().clone()

    resumed_cfg = _cfg(config_file, tmp_path, f"train.resume={run.ckpt_dir / CKPT_LAST}")
    _, fresh = _build_holding_model(
        resumed_cfg, create_run_dir(resumed_cfg), TinyNet(), tiny_loader
    )
    assert torch.allclose(fresh.centres, saved)


def test_resume_keeps_the_best_metric_so_a_worse_epoch_cannot_overwrite_it(
    config_file, tmp_path, tiny_model, tiny_loader
) -> None:
    cfg = _cfg(config_file, tmp_path)
    run = create_run_dir(cfg)
    trainer = _build(cfg, run, tiny_model, tiny_loader)
    trainer.state.best_metric = 0.125
    trainer.save_checkpoint(CKPT_LAST)

    resumed_cfg = _cfg(config_file, tmp_path, f"train.resume={run.ckpt_dir / CKPT_LAST}")
    resumed = _build(resumed_cfg, create_run_dir(resumed_cfg), tiny_model, tiny_loader)
    assert resumed.state.best_metric == 0.125
