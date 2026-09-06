"""ACER, HTER and the ROC an anti-spoof model is graded on.

ACER at a fixed threshold cannot rank models: one that separates the classes
perfectly still scores 0.5 with its whole distribution on one side, so the
threshold is fitted here and reported beside the rates it produced. Higher means
more live, and labels follow losses.task_loss: LIVE 0, SPOOF 1.
"""

from __future__ import annotations

import argparse
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import torch

from .losses.task_loss import LIVE


@dataclass(frozen=True)
class ErrorRates:
    """The three rates the branch reports, all at one threshold."""

    apcer: float
    bpcer: float
    acer: float
    threshold: float


def split_scores(scores: np.ndarray, labels: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Liveness scores of the live faces and of the attacks, in that order."""
    scores = np.asarray(scores, dtype=np.float64).ravel()
    labels = np.asarray(labels).ravel()
    if scores.shape != labels.shape:
        raise ValueError(f"{scores.shape} scores against {labels.shape} labels")
    return scores[labels == LIVE], scores[labels != LIVE]


def error_rates(scores: np.ndarray, labels: np.ndarray, threshold: float) -> ErrorRates:
    """APCER, BPCER and their mean, calling a sample live when score >= threshold."""
    live, attack = split_scores(scores, labels)
    apcer = float((attack >= threshold).mean()) if attack.size else 0.0
    bpcer = float((live < threshold).mean()) if live.size else 0.0
    return ErrorRates(apcer, bpcer, (apcer + bpcer) / 2.0, float(threshold))


def equal_error_rate(scores: np.ndarray, labels: np.ndarray) -> ErrorRates:
    """The rates where APCER and BPCER meet, and the threshold that gets there.

    The two rates cross exactly once, and the crossing is separability with the
    operating point taken out. This ranks checkpoints; the shipped threshold is
    a separate decision, made on val and held fixed on test.
    """
    live, attack = split_scores(scores, labels)
    if not live.size or not attack.size:
        return ErrorRates(0.0, 0.0, float("nan"), float("nan"))

    live_sorted, attack_sorted = np.sort(live), np.sort(attack)
    candidates = np.unique(np.concatenate([live_sorted, attack_sorted]))
    accepted = attack_sorted.size - np.searchsorted(attack_sorted, candidates, side="left")
    rejected = np.searchsorted(live_sorted, candidates, side="left")
    apcer = accepted / attack_sorted.size
    bpcer = rejected / live_sorted.size

    best = int(np.argmin(np.abs(apcer - bpcer)))
    return ErrorRates(
        float(apcer[best]),
        float(bpcer[best]),
        float((apcer[best] + bpcer[best]) / 2.0),
        float(candidates[best]),
    )


def auc(scores: np.ndarray, labels: np.ndarray) -> float:
    """Area under the ROC, live as the positive class.

    Computed from rank sums rather than by integrating a sampled curve, so ties
    between equal scores contribute the half they should and the result does not
    depend on how many thresholds were sampled.
    """
    live, attack = split_scores(scores, labels)
    if not live.size or not attack.size:
        return float("nan")

    order = np.concatenate([live, attack]).argsort(kind="mergesort")
    ranks = np.empty(order.size, dtype=np.float64)
    ranks[order] = np.arange(1, order.size + 1, dtype=np.float64)

    ordered = np.concatenate([live, attack])[order]
    start = 0
    for index in range(1, ordered.size + 1):
        if index == ordered.size or ordered[index] != ordered[start]:
            if index - start > 1:
                ranks[order[start:index]] = ranks[order[start:index]].mean()
            start = index

    live_rank_sum = ranks[: live.size].sum()
    return float((live_rank_sum - live.size * (live.size + 1) / 2.0) / (live.size * attack.size))


def summary(scores: np.ndarray, labels: np.ndarray) -> dict[str, float]:
    """The row a validation epoch logs: separability plus the rates behind it."""
    crossing = equal_error_rate(scores, labels)
    return {
        "auc": auc(scores, labels),
        "eer": crossing.acer,
        "apcer": crossing.apcer,
        "bpcer": crossing.bpcer,
        "threshold": crossing.threshold,
    }


def liveness_of(output: torch.Tensor, reference: torch.Tensor) -> torch.Tensor:
    """One score per sample, from whichever head the branch's two models have.

    The teacher draws a depth map and the student emits two logits, and both are
    read here rather than by the caller so a run is scored the same way whatever
    produced it.
    """
    if output.dim() >= 3:
        return output.flatten(1).mean(dim=1) / reference
    return output.softmax(dim=1)[:, LIVE]


@torch.no_grad()
def collect_scores(
    model: torch.nn.Module, loader: Iterable, device: torch.device
) -> tuple[np.ndarray, np.ndarray]:
    """Run one split through the model and return its scores beside its labels."""
    from .teacher.depth_gt import live_reference_mean

    model.eval()
    scores: list[np.ndarray] = []
    truth: list[np.ndarray] = []
    for tight, wide, labels, wide_scale in loader:
        output = model((tight.to(device), wide.to(device)))
        reference = torch.from_numpy(live_reference_mean(wide_scale.numpy())).to(device)
        scores.append(liveness_of(output, reference).float().cpu().numpy())
        truth.append(labels.numpy())
    return np.concatenate(scores), np.concatenate(truth)


def build_loader(cfg: object, split: str, root: Path | None = None) -> torch.utils.data.DataLoader:
    """The named split, read the way training reads it but without shuffling.

    root overrides where the shards live, which is how a cross-domain set is read
    through exactly the same path as the one a run was trained and validated on.
    """
    from .data import SpoofShardDataset, collate

    height, width = cfg.model.input_hw
    if height != width:
        raise ValueError(f"model.input_hw must be square for this branch, got {height}x{width}")
    dataset = SpoofShardDataset(
        root=Path(root or cfg.data.params["shards"]),
        size=int(height),
        train=False,
        seed=cfg.run.seed,
        splits=split,
    )
    return torch.utils.data.DataLoader(
        dataset,
        batch_size=cfg.data.batch_size,
        num_workers=cfg.data.num_workers,
        collate_fn=collate,
    )


def load_run(run: Path) -> tuple[object, torch.nn.Module]:
    """Rebuild a run's model from the config it froze, preferring its EMA copy."""
    from facepipe.core.config import load_config
    from facepipe.core.registry import MODELS, TEACHERS

    from .student import minifasnet_v2_se  # noqa: F401  registers the student
    from .teacher import cdcnpp  # noqa: F401  registers the teacher

    cfg = load_config(run / "config.resolved.yaml", [])
    spec = {"name": cfg.model.name, "params": cfg.model.params}
    model = TEACHERS.build(spec) if cfg.model.name in TEACHERS else MODELS.build(spec)

    payload = torch.load(run / "ckpt" / "best.pth", map_location="cpu", weights_only=False)
    model.load_state_dict(payload["ema"]["module"] if "ema" in payload else payload["model"])
    return cfg, model


def export_spec(run: Path, model: torch.nn.Module | None = None):
    """The module to trace, one example input, and the names of both ends.

    model overrides the run's own weights, which is how the quantisation
    passes export the graph they just rewrote.
    """
    from facepipe.core.config import load_config

    cfg = load_config(run / "config.resolved.yaml", [])
    model = model if model is not None else load_run(run)[1]
    model.eval()
    height, width = cfg.model.input_hw
    views = (torch.zeros(1, 3, height, width), torch.zeros(1, 3, height, width))
    return cfg, model, (views,), ["tight", "wide"], ["logits"]



def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True, help="a run directory under artifacts")
    parser.add_argument("--split", default=None, help="the split the reported rates come from")
    parser.add_argument("--fit-split", default=None, help="where the threshold is fitted")
    parser.add_argument("--device", default="cuda" if torch.cuda.is_available() else "cpu")
    parser.add_argument(
        "--xdomain",
        type=Path,
        action="append",
        default=[],
        help="a shard directory from another dataset, scored at the same threshold",
    )
    args = parser.parse_args(argv)

    device = torch.device(args.device)
    cfg, model = load_run(args.run)
    model = model.to(device)
    # The run's own splits, so a report cannot rest on a division it never saw.
    fit_split = args.fit_split or cfg.data.params["val_split"]
    held_split = args.split or cfg.data.params["test_split"]

    fit = collect_scores(model, build_loader(cfg, fit_split), device)
    crossing = equal_error_rate(*fit)
    print(f"{fit_split:12s} n={fit[0].size:<7} auc {auc(*fit):.4f}  eer {crossing.acer:.4f}")
    print(f"       threshold fitted here: {crossing.threshold:.6f}")

    held = collect_scores(model, build_loader(cfg, held_split), device)
    rates = error_rates(*held, crossing.threshold)
    print(f"\n{held_split:12s} n={held[0].size:<7} auc {auc(*held):.4f}")
    print(f"       apcer {rates.apcer:.4f}  bpcer {rates.bpcer:.4f}  ACER {rates.acer:.4f}")
    print(f"       eer   {equal_error_rate(*held).acer:.4f}  (not the gate, the threshold moved)")

    for shards in args.xdomain:
        # HTER is these rates at the home set's own threshold: refitting here
        # would report how separable the other set is, not how well this transfers.
        other = collect_scores(model, build_loader(cfg, ".", root=shards), device)
        live, attack = split_scores(*other)
        rates = error_rates(*other, crossing.threshold)
        print(f"\n{shards.name:24s} n={other[0].size:<6} live {live.size:<5} attack {attack.size}")
        if not live.size or not attack.size:
            rate, name = (rates.apcer, "apcer") if attack.size else (rates.bpcer, "bpcer")
            print(f"       {name} {rate:.4f}   (one class only: no auc, no HTER)")
            continue
        print(f"       auc {auc(*other):.4f}  apcer {rates.apcer:.4f}  bpcer {rates.bpcer:.4f}")
        print(f"       HTER {rates.acer:.4f}   eer {equal_error_rate(*other).acer:.4f}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
