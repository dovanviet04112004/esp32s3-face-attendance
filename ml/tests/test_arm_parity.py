"""KEHOACH section 3.7: the two arms of a branch may differ in one place only.

A knob that drifts between the arms puts its effect inside the number the table
reports, and nothing in a finished run reveals which part came from where. These
checks read the committed configs, so a divergence is caught before a run starts
rather than after both arms have been trained.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from facepipe.core.config import load_config

CONFIGS = Path(__file__).resolve().parents[1] / "configs"

ARMS = [
    pytest.param("antispoof/student_minifasnet.yaml", "antispoof/kd.yaml", id="antispoof"),
    pytest.param("recognition/student_mobilefacenet.yaml", "recognition/kd.yaml", id="recognition"),
]

# The left column of the table in section 3.7. A teacher cache in data.params is
# excluded below: it is the teacher, not a change of dataset.
SHARED = (
    "model.name",
    "model.input_hw",
    "model.params",
    "run.seed",
    "run.deterministic",
    "data.name",
    "data.batch_size",
    "data.split_files",
    "train.epochs",
    "train.amp",
    "train.amp_dtype",
    "train.ema_decay",
    "train.grad_clip_norm",
    "train.accum_steps",
    "train.val_every_epochs",
    "train.compile",
    "train.channels_last",
    "optim",
    "sched",
)

TEACHER_ONLY_DATA_KEYS = ("teacher_cache",)


def resolve(dotted: str, tree: dict):
    value = tree
    for key in dotted.split("."):
        value = value[key]
    return value


@pytest.mark.parametrize(("baseline_path", "kd_path"), ARMS)
def test_the_two_arms_differ_only_in_the_teacher(baseline_path: str, kd_path: str) -> None:
    baseline = load_config(CONFIGS / baseline_path).to_dict()
    kd = load_config(CONFIGS / kd_path).to_dict()

    for dotted in SHARED:
        assert resolve(dotted, baseline) == resolve(dotted, kd), f"{dotted} differs between arms"


@pytest.mark.parametrize(("baseline_path", "kd_path"), ARMS)
def test_the_kd_arm_only_adds_the_teacher_to_its_data_section(
    baseline_path: str, kd_path: str
) -> None:
    """A KD arm reading a different dataset would be a different experiment."""
    baseline = load_config(CONFIGS / baseline_path).to_dict()["data"]["params"]
    kd = load_config(CONFIGS / kd_path).to_dict()["data"]["params"]
    added = set(kd) - set(baseline)
    assert added <= set(TEACHER_ONLY_DATA_KEYS)
    for key in set(baseline):
        assert baseline[key] == kd[key], f"data.params.{key} differs between arms"


@pytest.mark.parametrize(("baseline_path", "kd_path"), ARMS)
def test_the_baseline_has_no_teacher_and_the_kd_arm_does(baseline_path: str, kd_path: str) -> None:
    baseline = load_config(CONFIGS / baseline_path)
    kd = load_config(CONFIGS / kd_path)
    assert not baseline.teacher.enabled and not baseline.distill.enabled
    assert kd.teacher.enabled and kd.distill.enabled
    assert kd.distill.losses, "the kd arm names no distillation term"


@pytest.mark.parametrize(("baseline_path", "kd_path"), ARMS)
def test_the_arms_are_told_apart_by_their_tags(baseline_path: str, kd_path: str) -> None:
    """The run directory is all that survives; its tags have to say which arm it is."""
    baseline = load_config(CONFIGS / baseline_path).run.tags
    kd = load_config(CONFIGS / kd_path).run.tags
    assert "arm_baseline" in baseline
    assert "arm_kd_full" in kd
