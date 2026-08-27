"""Forward hooks that capture intermediate feature maps for feature distillation.

Hooks are held by a context manager: leaking a hook keeps the captured tensors
and their graph alive, which shows up as a slow memory climb rather than a
crash.
"""

from __future__ import annotations

from collections.abc import Iterable, Iterator
from contextlib import contextmanager
from typing import Any

import torch
from torch import nn


class FeatureHooks:
    """Capture the output of named submodules during forward.

    Names are dotted paths as printed by `named_modules`, so a config can point
    at a layer without core knowing what the layer means.
    """

    def __init__(self, model: nn.Module, layer_names: Iterable[str], detach: bool = False) -> None:
        self._model = model
        self._names = list(layer_names)
        self._detach = detach
        self._features: dict[str, torch.Tensor] = {}
        self._handles: list[torch.utils.hooks.RemovableHandle] = []
        missing = [n for n in self._names if n not in dict(model.named_modules())]
        if missing:
            raise KeyError(f"layers absent from the model: {', '.join(missing)}")

    def _make_hook(self, name: str):
        def hook(_module: nn.Module, _inputs: Any, output: Any) -> None:
            tensor = output[0] if isinstance(output, tuple | list) else output
            self._features[name] = tensor.detach() if self._detach else tensor

        return hook

    def attach(self) -> FeatureHooks:
        """Register every hook. Idempotent."""
        if self._handles:
            return self
        modules = dict(self._model.named_modules())
        self._handles = [
            modules[name].register_forward_hook(self._make_hook(name)) for name in self._names
        ]
        return self

    def remove(self) -> None:
        """Unregister every hook and drop captured tensors."""
        for handle in self._handles:
            handle.remove()
        self._handles.clear()
        self._features.clear()

    def clear(self) -> None:
        """Drop captured tensors, keep the hooks attached."""
        self._features.clear()

    @property
    def features(self) -> dict[str, torch.Tensor]:
        return dict(self._features)

    @property
    def names(self) -> list[str]:
        return list(self._names)

    def __enter__(self) -> FeatureHooks:
        return self.attach()

    def __exit__(self, *exc: object) -> None:
        self.remove()


@contextmanager
def capture_features(
    model: nn.Module, layer_names: Iterable[str], detach: bool = False
) -> Iterator[FeatureHooks]:
    """Scoped feature capture."""
    hooks = FeatureHooks(model, layer_names, detach=detach).attach()
    try:
        yield hooks
    finally:
        hooks.remove()
