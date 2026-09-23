"""E5-T2 and E5-T3: the model and the loss it trains against."""

from __future__ import annotations

import io
from pathlib import Path

import numpy as np
import pytest
import torch
from PIL import Image

from facepipe.data.prepare.images_to_wds import KEY_FIELD, ShardWriter, read_shard
from facepipe.tasks.recognition.data import (
    Ms1mShardDataset,
    RecogTargets,
    decode,
    label_map,
    normalize_batch,
    read_identities,
)
from facepipe.tasks.recognition.losses import (
    ArcFaceLoss,
)
from facepipe.tasks.recognition.model import INPUT_SIZE, MobileFaceNet, MobileFaceNetECA
from facepipe.tasks.recognition.model.mobilefacenet import FINAL_MAP

EMBEDDING = 512


def face_bytes(shade: int, size: int = INPUT_SIZE) -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (size, size), (shade, shade // 2, 255 - shade)).save(buffer, format="JPEG")
    return buffer.getvalue()


def write_shards(root: Path, records: int, identities: int, shard_size: int = 4) -> Path:
    """Records laid out the way recordio_to_wds writes them: one jpg, one cls."""
    root.mkdir(parents=True, exist_ok=True)
    with ShardWriter(root, shard_size=shard_size) as writer:
        for index in range(records):
            writer.add(
                {"jpg": face_bytes(20 + index), "cls": str(index % identities).encode("ascii")}
            )
    return root


def test_the_model_emits_a_512_dimensional_embedding() -> None:
    model = MobileFaceNet().eval()
    out = model(torch.randn(2, 3, INPUT_SIZE, INPUT_SIZE))
    assert out.shape == (2, EMBEDDING)


def test_the_model_stays_inside_the_flash_budget() -> None:
    """A model over about 1.3M parameters no longer fits the branch's INT8 share."""
    total = sum(p.numel() for p in MobileFaceNet().parameters())
    assert 1_000_000 < total < 1_300_000


def test_the_eca_port_emits_a_512_dimensional_embedding_at_112() -> None:
    model = MobileFaceNetECA().eval()
    out = model(torch.randn(2, 3, 112, 112))
    assert out.shape == (2, EMBEDDING)


def test_the_eca_port_carries_frbench_parameter_names() -> None:
    """The published state dict loads strictly only if every name matches upstream's."""
    keys = MobileFaceNetECA().state_dict().keys()
    assert "conv_3.layers.0.eca.conv.weight" in keys
    assert "output_layer.bn.running_var" in keys
    assert sum(p.numel() for p in MobileFaceNetECA().parameters()) == 1_200_577


def test_the_eca_port_refuses_an_input_its_kernel_cannot_close() -> None:
    with pytest.raises(ValueError):
        MobileFaceNetECA(input_size=113)


def test_the_final_layer_weighs_cells_separately() -> None:
    """Global pooling would make the four corners of the map interchangeable.

    Replacing the depthwise kernel with a constant is exactly average pooling, so
    if the two agreed the layer would not be doing what it exists to do.
    """
    model = MobileFaceNet().eval()
    features = torch.randn(1, 512, FINAL_MAP, FINAL_MAP)
    with torch.no_grad():
        learned = model.head_dw(features)
        pooled = torch.nn.functional.adaptive_avg_pool2d(features, 1)
    assert not torch.allclose(learned, pooled, atol=1e-3)


def test_arcface_penalises_the_true_class_and_nothing_else() -> None:
    """The margin lowers the target cosine and leaves every other column alone."""
    loss = ArcFaceLoss(num_classes=4, embedding=8)
    cosine = torch.full((2, 4), 0.5)
    labels = torch.tensor([0, 3])
    adjusted = loss.margin_applied(cosine, labels)

    assert adjusted[0, 0] < cosine[0, 0]
    assert adjusted[1, 3] < cosine[1, 3]
    untouched = torch.tensor([[1, 2, 3], [0, 1, 2]])
    assert torch.allclose(adjusted.gather(1, untouched), cosine.gather(1, untouched))


def test_arcface_stays_monotone_past_the_turning_point() -> None:
    """Beyond pi minus the margin, cos(theta + m) rises again.

    Left unguarded the loss would reward a prediction pointing further from its
    class, so the penalty has to keep falling with the cosine there too.
    """
    loss = ArcFaceLoss(num_classes=2, embedding=4, margin=0.5)
    cosines = torch.linspace(-1.0, 1.0, 41).view(-1, 1).repeat(1, 2)
    labels = torch.zeros(41, dtype=torch.long)
    adjusted = loss.margin_applied(cosines, labels)[:, 0]
    assert torch.all(adjusted[1:] - adjusted[:-1] > 0)


def test_arcface_falls_as_the_embedding_turns_towards_its_class() -> None:
    loss = ArcFaceLoss(num_classes=3, embedding=4)
    with torch.no_grad():
        loss.weight.copy_(torch.eye(3, 4))
    labels = torch.tensor([0])
    aligned = loss(torch.tensor([[1.0, 0.0, 0.0, 0.0]]), RecogTargets(labels=labels))
    turned = loss(torch.tensor([[0.0, 1.0, 0.0, 0.0]]), RecogTargets(labels=labels))
    assert float(aligned.detach()) < float(turned.detach())


def test_arcface_trains_its_own_centres() -> None:
    """The class centres are parameters of the loss, so an optimizer must see them."""
    loss = ArcFaceLoss(num_classes=3, embedding=4)
    out = loss(torch.randn(2, 4), RecogTargets(labels=torch.tensor([0, 1])))
    out.backward()
    assert loss.weight.grad is not None and loss.weight.grad.abs().sum() > 0


def test_the_label_map_is_contiguous_from_zero() -> None:
    """ArcFace allocates one column per class, so a gap would train a dead column."""
    mapped = label_map([7, 3, 3, 900])
    assert sorted(mapped.values()) == [0, 1, 2]
    assert mapped[3] == 0 and mapped[900] == 2


def test_identities_are_read_from_the_split_file(tmp_path: Path) -> None:
    path = tmp_path / "train_ids.txt"
    path.write_text("12/x.jpg\n4\n\n99/y.jpg\n", encoding="utf-8")
    assert read_identities(path) == [12, 4, 99]


def test_normalising_bytes_lands_in_minus_one_to_one() -> None:
    images = torch.tensor([[[[0]], [[255]], [[128]]]], dtype=torch.uint8)
    out = normalize_batch(images)
    assert float(out.min()) == pytest.approx(-1.0)
    assert float(out.max()) == pytest.approx(1.0, abs=1e-2)


def test_a_record_carries_its_key_so_a_cache_can_be_addressed(tmp_path: Path) -> None:
    root = write_shards(tmp_path / "shards", records=4, identities=2, shard_size=4)
    keys = [record[KEY_FIELD].decode() for record in read_shard(next(root.glob("*.tar")))]
    assert keys == ["000000000", "000000001", "000000002", "000000003"]


def test_the_dataset_keeps_only_the_identities_of_its_own_split(tmp_path: Path) -> None:
    root = write_shards(tmp_path / "shards", records=12, identities=4, shard_size=4)
    dataset = Ms1mShardDataset(root, identities=[0, 2], train=False, shuffle_buffer=0)
    labels = sorted(sample.label for sample in dataset)
    assert dataset.num_classes == 2
    assert labels == [0, 0, 0, 1, 1, 1]
    assert len(dataset) == 6


def test_the_record_count_is_remembered_between_runs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Counting streams every shard, which a 36 GB epoch cannot pay at each start."""
    root = write_shards(tmp_path / "shards", records=8, identities=2, shard_size=4)
    assert len(Ms1mShardDataset(root, identities=[0], train=False)) == 4
    assert (root / "record_counts.json").is_file()

    def refuse(_path: Path):
        raise AssertionError("the count was recomputed instead of read back")

    monkeypatch.setattr("facepipe.tasks.recognition.data.read_shard", refuse)
    assert len(Ms1mShardDataset(root, identities=[0], train=False)) == 4


def test_reading_several_shards_at_once_mixes_identities(tmp_path: Path) -> None:
    """One shard at a time hands a batch a single person; MS1MV3 stores them so."""
    root = write_shards(tmp_path / "shards", records=16, identities=16, shard_size=4)
    identities = list(range(16))
    one = Ms1mShardDataset(root, identities, train=True, seed=0, shuffle_buffer=0, open_shards=1)
    many = Ms1mShardDataset(root, identities, train=True, seed=0, shuffle_buffer=0, open_shards=4)

    assert sorted(s.label for s in one) == sorted(s.label for s in many)
    first_four = [sample.label for sample in many][:4]
    assert len({label // 4 for label in first_four}) > 1


def test_decoding_returns_the_declared_size() -> None:
    image = decode(face_bytes(30, size=64), size=INPUT_SIZE)
    assert image.shape == (INPUT_SIZE, INPUT_SIZE, 3)
    assert image.dtype == np.uint8
