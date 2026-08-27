"""E2-T3: a name in YAML reaches the right constructor."""

from __future__ import annotations

import pytest
import yaml

from facepipe.core.registry import Registry, RegistryError


@pytest.fixture
def models() -> Registry:
    return Registry("model")


def test_decorator_registers_and_builds_from_yaml(models: Registry) -> None:
    @models.register("dummy")
    class Dummy:
        def __init__(self, width: int = 1, input_hw: tuple[int, int] = (8, 8)):
            self.width = width
            self.input_hw = input_hw

    spec = yaml.safe_load("name: dummy\nparams:\n  width: 7\n  input_hw: [16, 24]\n")
    built = models.build(spec)
    assert isinstance(built, Dummy)
    assert built.width == 7
    assert built.input_hw == [16, 24]


def test_name_defaults_to_symbol_name(models: Registry) -> None:
    @models.register()
    def tiny_head() -> str:
        return "ok"

    assert "tiny_head" in models
    assert models.get("tiny_head")() == "ok"


def test_extra_kwargs_reach_the_constructor(models: Registry) -> None:
    @models.register("needs_injection")
    class NeedsInjection:
        def __init__(self, sink: list[int], width: int = 2):
            self.sink = sink
            self.width = width

    sink: list[int] = []
    built = models.build({"name": "needs_injection", "params": {"width": 3}}, sink=sink)
    assert built.sink is sink
    assert built.width == 3


def test_duplicate_name_is_rejected(models: Registry) -> None:
    models.add("clash", lambda: 1)
    with pytest.raises(RegistryError, match="already registered"):
        models.add("clash", lambda: 2)


def test_reregistering_the_same_object_is_allowed(models: Registry) -> None:
    def same() -> int:
        return 1

    models.add("same", same)
    models.add("same", same)
    assert len(models) == 1


def test_missing_name_lists_alternatives(models: Registry) -> None:
    models.add("alpha", lambda: 1)
    models.add("beta", lambda: 2)
    with pytest.raises(RegistryError, match="alpha, beta"):
        models.get("gamma")


def test_spec_without_name_is_rejected(models: Registry) -> None:
    with pytest.raises(RegistryError, match="no 'name' key"):
        models.build({"params": {}})
