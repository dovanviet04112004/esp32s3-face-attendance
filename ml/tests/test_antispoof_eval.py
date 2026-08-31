"""E6: the error rates that rank an anti-spoof checkpoint."""

from __future__ import annotations

import numpy as np
import pytest

from facepipe.tasks.antispoof.eval import (
    auc,
    equal_error_rate,
    error_rates,
    split_scores,
    summary,
)
from facepipe.tasks.antispoof.losses.task_loss import LIVE, SPOOF

LIVE_FIRST = np.array([LIVE, LIVE, SPOOF, SPOOF])


def test_the_live_scores_come_back_separately_from_the_attacks() -> None:
    live, attack = split_scores(np.array([0.9, 0.8, 0.2, 0.1]), LIVE_FIRST)
    assert live.tolist() == [0.9, 0.8]
    assert attack.tolist() == [0.2, 0.1]


def test_a_score_and_label_count_that_disagree_is_an_error() -> None:
    with pytest.raises(ValueError):
        split_scores(np.array([0.9, 0.8]), LIVE_FIRST)


def test_separating_the_two_classes_scores_a_perfect_area() -> None:
    assert auc(np.array([0.9, 0.8, 0.2, 0.1]), LIVE_FIRST) == pytest.approx(1.0)


def test_ranking_every_attack_above_every_live_face_scores_zero() -> None:
    assert auc(np.array([0.1, 0.2, 0.8, 0.9]), LIVE_FIRST) == pytest.approx(0.0)


def test_one_score_for_everything_is_a_coin_toss() -> None:
    """Ties split evenly, so a model with no signal lands on 0.5 rather than 1.0."""
    assert auc(np.full(4, 0.5), LIVE_FIRST) == pytest.approx(0.5)


def test_a_single_tie_moves_the_area_by_half_a_pair() -> None:
    scores = np.array([0.9, 0.5, 0.5, 0.1])
    assert auc(scores, LIVE_FIRST) == pytest.approx(0.875)


def test_a_split_with_only_one_class_is_not_a_number() -> None:
    assert np.isnan(auc(np.array([0.9, 0.8]), np.array([LIVE, LIVE])))
    assert np.isnan(equal_error_rate(np.array([0.9, 0.8]), np.array([LIVE, LIVE])).acer)


def test_a_threshold_above_everything_rejects_every_live_face() -> None:
    rates = error_rates(np.array([0.9, 0.8, 0.2, 0.1]), LIVE_FIRST, threshold=1.0)
    assert rates.apcer == pytest.approx(0.0)
    assert rates.bpcer == pytest.approx(1.0)
    assert rates.acer == pytest.approx(0.5)


def test_a_threshold_below_everything_accepts_every_attack() -> None:
    rates = error_rates(np.array([0.9, 0.8, 0.2, 0.1]), LIVE_FIRST, threshold=0.0)
    assert rates.apcer == pytest.approx(1.0)
    assert rates.bpcer == pytest.approx(0.0)


def test_the_crossing_of_a_separated_set_costs_nothing() -> None:
    crossing = equal_error_rate(np.array([0.9, 0.8, 0.2, 0.1]), LIVE_FIRST)
    assert crossing.acer == pytest.approx(0.0)
    assert 0.2 < crossing.threshold <= 0.8


def test_a_model_that_separates_perfectly_is_not_punished_for_its_scale() -> None:
    """The bug this replaced: every score under the fixed cut read as 0.5 ACER.

    An untrained depth map scores near zero, so a constant threshold called every
    sample an attack and reported the same number for a useless model and for one
    that had learnt the split. The crossing is found on the scores themselves, so
    a model whose whole distribution sits low still shows the separation it has.
    """
    tiny = np.array([2e-4, 1.9e-4, 1e-5, 5e-6])
    assert error_rates(tiny, LIVE_FIRST, threshold=0.5).acer == pytest.approx(0.5)
    assert equal_error_rate(tiny, LIVE_FIRST).acer == pytest.approx(0.0)
    assert auc(tiny, LIVE_FIRST) == pytest.approx(1.0)


def test_an_overlap_costs_both_rates_at_the_crossing() -> None:
    scores = np.array([0.9, 0.4, 0.6, 0.1])
    crossing = equal_error_rate(scores, np.array([LIVE, LIVE, SPOOF, SPOOF]))
    assert crossing.acer == pytest.approx(0.5)
    assert crossing.apcer == pytest.approx(crossing.bpcer)


def test_the_summary_carries_the_key_the_trainer_selects_on() -> None:
    row = summary(np.array([0.9, 0.8, 0.2, 0.1]), LIVE_FIRST)
    assert set(row) == {"auc", "eer", "apcer", "bpcer", "threshold"}
    assert row["eer"] == pytest.approx(0.0)
    assert row["auc"] == pytest.approx(1.0)


def test_the_rates_stay_in_range_on_a_larger_random_set() -> None:
    rng = np.random.default_rng(0)
    labels = rng.integers(0, 2, size=500)
    scores = rng.normal(loc=np.where(labels == LIVE, 1.0, 0.0), scale=1.0)
    row = summary(scores, labels)
    assert 0.5 < row["auc"] <= 1.0
    assert 0.0 <= row["eer"] <= 0.5
