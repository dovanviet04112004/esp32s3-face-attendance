"""Fixes to ESP-PPQ 1.3.11, each in force only for the branches whose block in quant.yaml names it.

A patch enters around every place its branch uses ESP-PPQ: quantising, simulating and exporting
(KEHOACH 3.7). Each one records the board symptom it answers and has a test pinning it; an export
patch only drops work ESP-PPQ leaves for the chip and never changes an integer of the graph.
"""

from __future__ import annotations

import contextlib
from collections.abc import Callable, Iterator, Sequence

PATCHES: dict[str, Callable[[], contextlib.AbstractContextManager[None]]] = {}


@contextlib.contextmanager
def applied(names: Sequence[str]) -> Iterator[None]:
    """Every patch of names in force, entered in the order given and undone in reverse."""
    unknown = [name for name in names if name not in PATCHES]
    if unknown:
        raise ValueError(f"no ESP-PPQ patch named {unknown}; known: {sorted(PATCHES)}")
    with contextlib.ExitStack() as stack:
        for name in names:
            stack.enter_context(PATCHES[name]())
        yield
