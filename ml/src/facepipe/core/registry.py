"""Name-to-callable registries, so YAML can select code without importing it.

A registry holds no knowledge of what it stores. Branch-specific entries live in
tasks/<branch>/ and register themselves on import; core never names them.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator, Mapping
from typing import Any, TypeVar

T = TypeVar("T")


class RegistryError(KeyError):
    """Raised when a name is missing or registered twice."""


class Registry:
    """A single namespace mapping names to constructors."""

    def __init__(self, kind: str) -> None:
        self._kind = kind
        self._entries: dict[str, Callable[..., Any]] = {}

    @property
    def kind(self) -> str:
        return self._kind

    def register(self, name: str | None = None) -> Callable[[T], T]:
        """Decorator form: @MODELS.register("yunet")."""

        def wrap(obj: T) -> T:
            key = name or getattr(obj, "__name__", None)
            if key is None:
                raise RegistryError(f"{self._kind}: cannot infer a name for {obj!r}")
            self.add(key, obj)  # type: ignore[arg-type]
            return obj

        return wrap

    def add(self, name: str, obj: Callable[..., Any]) -> None:
        """Register under an explicit name."""
        if name in self._entries and self._entries[name] is not obj:
            raise RegistryError(f"{self._kind}: {name!r} is already registered")
        self._entries[name] = obj

    def get(self, name: str) -> Callable[..., Any]:
        """Look up a constructor, listing the alternatives when it is missing."""
        try:
            return self._entries[name]
        except KeyError:
            known = ", ".join(sorted(self._entries)) or "<empty>"
            raise RegistryError(f"{self._kind}: {name!r} not registered. Known: {known}") from None

    def build(self, spec: Mapping[str, Any], **extra: Any) -> Any:
        """Instantiate from a mapping shaped {"name": ..., "params": {...}}.

        Keyword arguments in extra are passed through, letting a caller inject
        objects that cannot be written in YAML.
        """
        if "name" not in spec:
            raise RegistryError(f"{self._kind}: spec has no 'name' key: {dict(spec)!r}")
        params = dict(spec.get("params") or {})
        params.update(extra)
        return self.get(str(spec["name"]))(**params)

    def names(self) -> list[str]:
        return sorted(self._entries)

    def __contains__(self, name: object) -> bool:
        return name in self._entries

    def __len__(self) -> int:
        return len(self._entries)

    def __iter__(self) -> Iterator[str]:
        return iter(sorted(self._entries))

    def __repr__(self) -> str:
        return f"Registry({self._kind!r}, {len(self._entries)} entries)"


MODELS = Registry("model")
TEACHERS = Registry("teacher")
LOSSES = Registry("loss")
DATASETS = Registry("dataset")
TRANSFORMS = Registry("transform")
OPTIMIZERS = Registry("optimizer")
SCHEDULERS = Registry("scheduler")

ALL_REGISTRIES: dict[str, Registry] = {
    r.kind: r for r in (MODELS, TEACHERS, LOSSES, DATASETS, TRANSFORMS, OPTIMIZERS, SCHEDULERS)
}
