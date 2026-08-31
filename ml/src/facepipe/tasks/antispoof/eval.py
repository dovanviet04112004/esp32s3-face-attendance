"""ACER, HTER and the ROC an anti-spoof model is graded on.

A liveness score is a number, and every error rate below is that number read
against a threshold. Which threshold is the whole question: ACER at a fixed one
cannot rank models, because a model that separates live from attack perfectly
still scores 0.5 if its whole distribution sits on one side. So the threshold is
fitted here, on the same scores, and reported alongside the rates it produced.

Score convention: higher means more live. Labels follow losses.task_loss, where
LIVE is 0 and SPOOF is 1.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

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

    APCER falls and BPCER rises with the threshold, so they cross exactly once
    and the crossing is the model's separability with the operating point taken
    out. This is what ranks two checkpoints; the shipped threshold is a separate
    decision made once, on val, and then held fixed on test.
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
