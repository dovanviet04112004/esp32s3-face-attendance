"""E9-T29: the ESP-DL export path, from the fold ESP-PPQ needs to the image the board reads."""

from __future__ import annotations

import hashlib
import json
import struct
from pathlib import Path

import pytest
import torch
from torch import nn

from facepipe.compress.quant.fold_bn import fold_linear
from facepipe.export import espdl_op_check
from facepipe.export.pack_models_partition import (
    ENTRY_FORMAT,
    HEADER_BYTES,
    MAGIC,
    build_image,
    deployed,
    payload_runtime,
    publish,
    release_version,
)


def settled(norm: nn.BatchNorm1d) -> nn.BatchNorm1d:
    """A norm with running statistics far from the identity, the way a trained one ends up."""
    with torch.no_grad():
        norm.running_mean.uniform_(-2.0, 2.0)
        norm.running_var.uniform_(0.2, 3.0)
        if norm.affine:
            norm.weight.uniform_(0.5, 1.5)
            norm.bias.uniform_(-1.0, 1.0)
    return norm.eval()


@pytest.mark.parametrize("affine", [True, False])
def test_folding_a_linear_norm_keeps_the_function(affine: bool) -> None:
    torch.manual_seed(0)
    model = nn.Sequential(nn.Linear(16, 8, bias=False), settled(nn.BatchNorm1d(8, affine=affine)))
    x = torch.randn(5, 16)
    with torch.no_grad():
        before = model(x)
        assert fold_linear(model) == 1
        after = model(x)
    assert isinstance(model[1], nn.Identity)
    assert torch.allclose(before, after, atol=1e-5)


def write_model(models_dir: Path, branch: str, name: str, blob: bytes, lock: dict) -> None:
    folder = models_dir / branch
    folder.mkdir(parents=True, exist_ok=True)
    (folder / name).write_bytes(blob)
    digest = hashlib.sha256(blob).hexdigest()
    meta = {"in_h": 112, "in_w": 112, "arena_hint": 0, "sha256": digest, "run_id": f"{branch}/x"}
    (folder / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    lock[branch] = {"file": name, "sha256": digest, "run_id": f"{branch}/x", "arena_bytes": 0}


ESPDL_BLOB = b"EDL2" + bytes(60)
TFLITE_BLOB = b"\x1c\x00\x00\x00TFL3" + bytes(56)


def test_payload_runtime_reads_each_file_own_magic(tmp_path: Path) -> None:
    (tmp_path / "a.espdl").write_bytes(ESPDL_BLOB)
    (tmp_path / "b.tflite").write_bytes(TFLITE_BLOB)
    assert payload_runtime(tmp_path / "a.espdl") == "espdl"
    assert payload_runtime(tmp_path / "b.tflite") == "tflm"


def test_one_image_refuses_two_runtimes(tmp_path: Path) -> None:
    lock: dict = {}
    write_model(tmp_path, "detection", "yunet_s8.espdl", ESPDL_BLOB, lock)
    write_model(tmp_path, "recognition", "mobilefacenet_int8.tflite", TFLITE_BLOB, lock)
    (tmp_path / "models.lock.json").write_text(json.dumps(lock), encoding="utf-8")
    with pytest.raises(SystemExit, match="one runtime"):
        deployed(tmp_path / "models.lock.json", tmp_path)


def test_an_espdl_image_keeps_the_header_the_firmware_reads(tmp_path: Path) -> None:
    lock: dict = {}
    write_model(tmp_path, "recognition", "mobilefacenet_s8.espdl", ESPDL_BLOB, lock)
    (tmp_path / "models.lock.json").write_text(json.dumps(lock), encoding="utf-8")
    image = build_image(deployed(tmp_path / "models.lock.json", tmp_path), built_at=0)
    assert image[:4] == MAGIC
    name, offset, size, _sha, in_h, in_w, arena = struct.unpack_from(ENTRY_FORMAT, image, 16)
    assert name.rstrip(b"\0") == b"recog"
    assert (offset, size, in_h, in_w, arena) == (HEADER_BYTES, len(ESPDL_BLOB), 112, 112, 0)
    assert image[offset : offset + 4] == b"EDL2"


def test_a_models_release_is_named_as_the_heartbeat_names_it(tmp_path: Path) -> None:
    lock: dict = {}
    write_model(tmp_path, "recognition", "mobilefacenet_s8.espdl", ESPDL_BLOB, lock)
    (tmp_path / "models.lock.json").write_text(json.dumps(lock), encoding="utf-8")
    image = build_image(deployed(tmp_path / "models.lock.json", tmp_path), built_at=0)
    (crc,) = struct.unpack_from("<I", image, HEADER_BYTES - 4)
    assert release_version(image) == f"img-{crc:08x}"


def test_publishing_goes_through_the_release_door(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: dict = {}

    class Answer:
        def __enter__(self) -> Answer:
            return self

        def __exit__(self, *_: object) -> None:
            return None

        def read(self) -> bytes:
            return b'{"existing": false, "release": {"version": "img-00000001", "sha256": "ab"}}'

    def urlopen(sent, timeout):
        seen.update(url=sent.full_url, body=sent.data, method=sent.method)
        seen["auth"] = sent.get_header("Authorization")
        return Answer()

    monkeypatch.setattr("urllib.request.urlopen", urlopen)
    answer = publish(b"image", "img-00000001", "https://api.example/", "t" * 32)
    assert seen == {
        "url": "https://api.example/releases?target=MODELS&version=img-00000001",
        "body": b"image",
        "auth": "Bearer " + "t" * 32,
        "method": "POST",
    }
    assert answer["existing"] is False


def test_registered_reads_the_module_creator(tmp_path: Path) -> None:
    header = tmp_path / "dl_module_creator.hpp"
    header.write_text(
        'this->register_module("Conv", Conv::deserialize);\n'
        'this->register_module( "PRelu", PRelu::deserialize);\n',
        encoding="utf-8",
    )
    assert espdl_op_check.registered(header) == {"Conv", "PRelu"}


class Expanded(nn.Module):
    """A channel gate written with expand_as, the way the published ECA block is."""

    def __init__(self) -> None:
        super().__init__()
        self.conv = nn.Conv2d(3, 8, 3, padding=1)
        self.pool = nn.AdaptiveAvgPool2d(1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        y = self.conv(x)
        return y * torch.sigmoid(self.pool(y)).expand_as(y)


def export_espdl(model: nn.Module, work: Path, name: str) -> Path:
    from facepipe.compress.quant import ptq_espdl

    onnx_path = work / f"{name}.onnx"
    torch.onnx.export(
        model.eval(),
        (torch.zeros(1, 3, 8, 8),),
        str(onnx_path),
        opset_version=13,
        input_names=["image"],
        output_names=["out"],
        dynamo=False,
    )
    calib = [torch.rand(1, 3, 8, 8) for _ in range(4)]
    out = work / f"{name}.espdl"
    ptq_espdl.quantize(onnx_path, calib, out)
    return out


def test_the_op_check_catches_expand_and_the_digest_ignores_export_noise(tmp_path: Path) -> None:
    pytest.importorskip("esp_ppq")
    torch.manual_seed(0)
    model = Expanded()
    first = export_espdl(model, tmp_path, "first")
    second = export_espdl(model, tmp_path, "second")
    header = tmp_path / "dl_module_creator.hpp"
    header.write_text(
        "".join(
            f'register_module("{op}", x);\n'
            for op in ("Conv", "GlobalAveragePool", "Sigmoid", "Mul")
        ),
        encoding="utf-8",
    )
    assert "Expand" in espdl_op_check.operators(first)
    assert espdl_op_check.main(["--model", str(first), "--creator", str(header)]) == 1
    assert espdl_op_check.input_shape(first) == [1, 8, 8, 3]
    assert espdl_op_check.content_digest(first) == espdl_op_check.content_digest(second)
