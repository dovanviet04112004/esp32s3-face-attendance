"""The .gold container the three branches write and the board reads back.

One flat little-endian block per case (KEHOACH 4.3): a zip would need a parser
on the MCU longer than the check it serves. Branch emitters build the cases and
call write_case; parity on the board walks the same records.
"""

from __future__ import annotations

import struct
from pathlib import Path

import numpy as np

MAGIC = b"GOLD"
VERSION = 1
NAME_BYTES = 32
MAX_DIMS = 4
DTYPES = {"float32": 0, "int8": 1, "int32": 2, "uint8": 3, "uint16": 4}
CODE_TO_DTYPE = {code: name for name, code in DTYPES.items()}


def _record(name: str, array: np.ndarray) -> bytes:
    encoded = name.encode("ascii")
    if len(encoded) >= NAME_BYTES:
        raise ValueError(f"tensor name {name!r} does not fit {NAME_BYTES} bytes")
    if array.ndim > MAX_DIMS:
        raise ValueError(f"{name}: {array.ndim} dims, the container holds {MAX_DIMS}")
    if array.dtype.name not in DTYPES:
        raise ValueError(f"{name}: dtype {array.dtype} is not one the board reads")
    payload = np.ascontiguousarray(array).tobytes()
    dims = list(array.shape) + [0] * (MAX_DIMS - array.ndim)
    head = struct.pack(
        f"<{NAME_BYTES}sII{MAX_DIMS}II",
        encoded,
        DTYPES[array.dtype.name],
        array.ndim,
        *dims,
        len(payload),
    )
    return head + payload + b"\0" * (-len(payload) % 4)


def write_case(path: Path, tensors: dict[str, np.ndarray]) -> Path:
    """One case file, tensors in the order the branch listed them."""
    path.parent.mkdir(parents=True, exist_ok=True)
    body = b"".join(_record(name, array) for name, array in tensors.items())
    path.write_bytes(struct.pack("<4sII", MAGIC, VERSION, len(tensors)) + body)
    return path


def read_case(path: Path) -> dict[str, np.ndarray]:
    """The tensors of one case, for a host test that never touches the board."""
    blob = path.read_bytes()
    magic, version, count = struct.unpack_from("<4sII", blob, 0)
    if magic != MAGIC or version != VERSION:
        raise ValueError(f"{path}: not a version {VERSION} .gold file")
    out: dict[str, np.ndarray] = {}
    offset = 12
    head = struct.calcsize(f"<{NAME_BYTES}sII{MAX_DIMS}II")
    for _ in range(count):
        fields = struct.unpack_from(f"<{NAME_BYTES}sII{MAX_DIMS}II", blob, offset)
        name = fields[0].split(b"\0", 1)[0].decode("ascii")
        dtype, ndim, nbytes = CODE_TO_DTYPE[fields[1]], fields[2], fields[-1]
        shape = tuple(fields[3 : 3 + ndim])
        start = offset + head
        out[name] = np.frombuffer(
            blob, dtype=dtype, count=nbytes // np.dtype(dtype).itemsize, offset=start
        ).reshape(shape)
        offset = start + nbytes + (-nbytes % 4)
    return out
