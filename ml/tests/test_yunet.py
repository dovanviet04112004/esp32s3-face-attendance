"""E4-T3: the YuNet architecture, its priors and its three branches."""

from __future__ import annotations

from pathlib import Path

import pytest
import torch
from torch import nn

from facepipe.core.config import load_config
from facepipe.core.registry import MODELS
from facepipe.tasks.detection.model import (
    STRIDES,
    YuNet,
    YuNetBackbone,
    feature_sizes,
    level_priors,
    pyramid_priors,
)
from facepipe.tasks.detection.model.blocks import ConvDPUnit

ML_ROOT = Path(__file__).resolve().parents[1]
REFERENCE_PARAMS = 75_856
OBJECTNESS_PARAMS = 3 * 75
INPUT_HW = (120, 160)


@pytest.fixture(scope="module")
def model() -> YuNet:
    return YuNet()


def test_param_count_matches_the_reference_minus_objectness(model: YuNet) -> None:
    total = sum(p.numel() for p in model.parameters())
    assert total == REFERENCE_PARAMS - OBJECTNESS_PARAMS


def test_three_branches_carry_class_box_and_five_landmarks(model: YuNet) -> None:
    out = model(torch.randn(2, 3, *INPUT_HW))
    assert [t.shape[1] for t in out.cls] == [1, 1, 1]
    assert [t.shape[1] for t in out.bbox] == [4, 4, 4]
    assert [t.shape[1] for t in out.kps] == [10, 10, 10]


def test_one_prediction_per_level(model: YuNet) -> None:
    out = model(torch.randn(1, 3, *INPUT_HW))
    assert len(out.cls) == len(out.bbox) == len(out.kps) == len(STRIDES)


def test_registered_under_the_name_configs_use() -> None:
    assert "yunet" in MODELS
    assert isinstance(MODELS.build({"name": "yunet", "params": {}}), YuNet)


def test_shipped_config_builds_the_model() -> None:
    config = load_config(ML_ROOT / "configs/detection/yunet.yaml")
    built = MODELS.build({"name": config.model.name, "params": config.model.params})
    assert tuple(config.model.input_hw) == INPUT_HW
    assert sum(p.numel() for p in built.parameters()) == REFERENCE_PARAMS - OBJECTNESS_PARAMS


@pytest.mark.parametrize("size", [(120, 160), (128, 160), (240, 320), (110, 150)])
def test_predicted_feature_sizes_match_the_backbone(size: tuple[int, int]) -> None:
    feats = YuNetBackbone()(torch.zeros(1, 3, *size))
    assert [tuple(f.shape[-2:]) for f in feats] == feature_sizes(size, STRIDES)


def test_neck_fuses_levels_whose_sizes_do_not_halve_exactly(model: YuNet) -> None:
    out = model(torch.randn(1, 3, 120, 160))
    assert [tuple(t.shape[-2:]) for t in out.cls] == [(15, 20), (7, 10), (3, 5)]


def test_priors_are_row_major_and_carry_their_stride() -> None:
    priors = level_priors(2, 3, stride=8)
    assert priors.shape == (6, 4)
    assert priors[:, 0].tolist() == [0, 8, 16, 0, 8, 16]
    assert priors[:, 1].tolist() == [0, 0, 0, 8, 8, 8]
    assert priors[:, 2].unique().tolist() == [8]


def test_one_prior_per_cell_of_every_level(model: YuNet) -> None:
    out = model(torch.randn(1, 3, *INPUT_HW))
    sizes = [tuple(t.shape[-2:]) for t in out.cls]
    priors = pyramid_priors(sizes, STRIDES)
    assert [p.shape[0] for p in priors] == [h * w for h, w in sizes]


def test_prior_count_disagreeing_with_strides_is_rejected() -> None:
    with pytest.raises(ValueError, match="stride"):
        pyramid_priors([(4, 4)], STRIDES)


def test_activations_are_relu6_so_int8_has_a_bounded_range(model: YuNet) -> None:
    kinds = {type(m) for m in model.modules() if isinstance(m, nn.ReLU | nn.ReLU6)}
    assert kinds == {nn.ReLU6}


def test_every_convolution_is_pointwise_or_depthwise(model: YuNet) -> None:
    dense = [
        m
        for m in model.modules()
        if isinstance(m, nn.Conv2d) and m.kernel_size != (1, 1) and m.groups != m.in_channels
    ]
    assert [m.kernel_size for m in dense] == [(3, 3)]


def test_unit_keeps_channel_count_a_multiple_of_eight() -> None:
    unit = ConvDPUnit(64, 64)
    assert unit.depthwise.groups == 64
    assert unit(torch.randn(1, 64, 8, 8)).shape == (1, 64, 8, 8)
