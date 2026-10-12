"""KEHOACH 3.7: a branch's ESP-PPQ patches enter in order, leave in reverse, and all exist."""

from __future__ import annotations

import contextlib

import pytest

from facepipe.compress.quant import esp_ppq_patches, ptq_espdl


def recording(name: str, seen: list[str]):
    @contextlib.contextmanager
    def patch():
        seen.append(f"+{name}")
        try:
            yield
        finally:
            seen.append(f"-{name}")

    return patch


def test_patches_enter_in_order_and_leave_in_reverse(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[str] = []
    monkeypatch.setattr(
        esp_ppq_patches, "PATCHES", {"a": recording("a", seen), "b": recording("b", seen)}
    )
    with esp_ppq_patches.applied(["b", "a"]):
        seen.append("body")
    assert seen == ["+b", "+a", "body", "-a", "-b"]


def test_a_patch_leaves_even_when_the_body_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[str] = []
    monkeypatch.setattr(esp_ppq_patches, "PATCHES", {"a": recording("a", seen)})
    with pytest.raises(RuntimeError), esp_ppq_patches.applied(["a"]):
        raise RuntimeError
    assert seen == ["+a", "-a"]


def test_an_unknown_patch_is_refused_before_any_enters(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[str] = []
    monkeypatch.setattr(esp_ppq_patches, "PATCHES", {"a": recording("a", seen)})
    with (
        pytest.raises(ValueError, match="no ESP-PPQ patch named"),
        esp_ppq_patches.applied(["a", "missing"]),
    ):
        pass
    assert seen == []


def test_no_patch_at_all_changes_nothing() -> None:
    with esp_ppq_patches.applied([]):
        pass


def test_every_branch_names_only_patches_that_exist() -> None:
    for branch in ("detection", "antispoof", "recognition"):
        names = ptq_espdl.block(branch)["esp_ppq_patches"]
        assert set(names) <= set(esp_ppq_patches.PATCHES), branch
