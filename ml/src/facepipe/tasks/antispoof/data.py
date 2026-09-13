"""CelebA-Spoof shards to batches of two crops and a label.

Records are read front to back, never seeked (KEHOACH 4.4.1), so shuffling comes
from the shard order plus a buffer held back before yielding. The pair of crops
belongs to one face: pairing a tight crop with another face's wide crop teaches
that context and face are unrelated, which is the opposite of the point.
"""

from __future__ import annotations

import io
import json
import random
import tarfile
from collections.abc import Iterator, Sequence
from dataclasses import dataclass, replace
from functools import lru_cache
from pathlib import Path

import numpy as np
import torch
from PIL import Image
from torch.utils.data import IterableDataset, get_worker_info

from facepipe.data.prepare.images_to_wds import read_shard

CROP_SIZE = 81
SHUFFLE_BUFFER = 2048
# Drawn from one distribution for both classes: every source record below 1.0x is
# an attack, so scale alone predicts the label (KEHOACH 3, layer 2).
CROP_SCALE_RANGE = (0.7, 1.2)
# This crop can only narrow, so an ungated draw moves every sample off the scale
# the kiosk builds and starves the wide branch of context (KEHOACH 3, layer 2).
CROP_SCALE_PROBABILITY = 0.15
# Spans both pools the branch meets, so neither end can cue the label (KEHOACH 1.3).
QUALITY_RANGE = (30, 95)
RECOMPRESS_PROBABILITY = 0.5
# Device frames at the gain ceiling, averaged down to the crop, sit at sigma 2.2-2.9 (measurements 24.1).
PHOTON_RANGE = (8000.0, 16000.0)
READ_SIGMA_RANGE = (1.5, 3.0)
# The rest of the OV5640 path, drawn per sample (KEHOACH section 3, layer 2).
WHITE_BALANCE_RANGE = (0.86, 1.16)
VIGNETTE_RANGE = (0.10, 0.55)
MOTION_BLUR_PX = (3, 7)
BACKLIGHT_RANGE = (0.15, 0.60)
MID_LEVEL = 127.5
# Symmetric in log about 1.0, which is what keeps the blown-highlight tail in the
# pool the branch trains on (KEHOACH 3).
EXPOSURE_GAIN_RANGE = (0.55, 1.80)
EXPOSURE_CONTRAST_RANGE = (0.50, 1.50)
PHOTOMETRIC_PROBABILITY = 0.5
# Side of the patch as a fraction of the face box (KEHOACH 3, layer 2).
OCCLUSION_SIDE_RANGE = (0.20, 0.45)
# Gated for the reason the crop scale is: this only ever hides, so every sample
# carrying a patch would move the pool off what the kiosk sees (KEHOACH 3).
OCCLUSION_PROBABILITY = 0.25
# Degrees of head roll, drawn per sample (KEHOACH 3, layer 2).
ROLL_RANGE = (-18.0, 18.0)
ROLL_PROBABILITY = 0.35
# Fraction of the face box the crop is moved by, symmetric so it widens the pool
# rather than favouring one side (KEHOACH 3, layer 2).
TRANSLATE_RANGE = 0.10
TRANSLATE_PROBABILITY = 0.5


@dataclass
class SpoofSample:
    """One face: the tight view, the context view, and whether it is an attack.

    A one-backbone model drops the context view once the crop scale has been cut
    from it, and every augmentation after that point sees wide as None.
    """

    tight: np.ndarray
    wide: np.ndarray | None
    label: int
    wide_scale: float  # scale the wide view actually reached
    face_in_wide: tuple[float, float, float, float] = (0.0, 0.0, 1.0, 1.0)

    def views(self) -> list[np.ndarray]:
        return [self.tight] if self.wide is None else [self.tight, self.wide]

    def scaled_views(self) -> list[tuple[np.ndarray, float]]:
        """Each view with the crop scale its own pixels are laid out at."""
        return list(zip(self.views(), (1.0, self.wide_scale), strict=False))

    def with_views(self, views: list[np.ndarray]) -> SpoofSample:
        return replace(self, tight=views[0], wide=views[1] if self.wide is not None else None)

    def mapped(self, per_view) -> SpoofSample:
        return self.with_views([per_view(view) for view in self.views()])


def shard_paths(root: Path) -> list[Path]:
    return sorted(Path(root).glob("shard_*.tar"))


def resolve_spec(root: Path, spec: str) -> list[Path]:
    """Shards named by "split" or by "split:start:end", the end exclusive.

    Slicing by shard buys reproducibility, not identity separation: the mirror
    ships no identity labels and its own ordering already interleaves the two
    classes, so a person can appear on both sides of a cut (SPLIT.md).
    """
    parts = str(spec).split(":")
    shards = shard_paths(Path(root) / parts[0])
    if not shards:
        raise FileNotFoundError(f"{Path(root) / parts[0]}: no shard_*.tar")
    if len(parts) == 1:
        return shards
    if len(parts) != 3:
        raise ValueError(f"{spec!r}: expected 'split' or 'split:start:end'")
    start = int(parts[1]) if parts[1] else 0
    end = int(parts[2]) if parts[2] else len(shards)
    chosen = shards[start:end]
    if not chosen:
        raise ValueError(f"{spec!r} selects nothing from {len(shards)} shards")
    return chosen


def resolve_splits(root: Path, specs: str | Sequence[str]) -> tuple[list[Path], int]:
    """Every shard the specs name, and an exact record count for them.

    Counted per spec, not over the merged list: only the last shard of a run is
    short, and merging buries the short ones where the arithmetic would skip them.
    """
    if isinstance(specs, str):
        specs = [specs]
    shards: list[Path] = []
    total = 0
    for spec in specs:
        chosen = resolve_spec(root, spec)
        shards.extend(chosen)
        total += count_records(chosen)
    return shards, total


def records_in(shard: Path) -> int:
    """How many records one shard holds, by reading its member names."""
    with tarfile.open(shard, "r|") as archive:
        return sum(1 for member in archive if member.name.endswith(".json"))


def count_records(shards: list[Path], shard_size: int | None = None) -> int:
    """Total records without reading every shard.

    Shards hold a fixed size, so the first one measures it and only the last,
    which may be short, has to be counted too.
    """
    if not shards:
        return 0
    if len(shards) == 1:
        return records_in(shards[0])
    full = shard_size if shard_size is not None else records_in(shards[0])
    return (len(shards) - 1) * full + records_in(shards[-1])


def resized(image: np.ndarray, size: int) -> np.ndarray:
    if image.shape[0] == size and image.shape[1] == size:
        return image
    return np.array(Image.fromarray(image).resize((size, size), Image.BILINEAR), dtype=np.uint8)


def decode_native(payload: bytes) -> np.ndarray:
    with Image.open(io.BytesIO(payload)) as handle:
        return np.array(handle.convert("RGB"), dtype=np.uint8)


def decode(payload: bytes, size: int) -> np.ndarray:
    return resized(decode_native(payload), size)


def centred_face(reached: float) -> tuple[float, float, float, float]:
    """Where the face sits in a wide crop built about its own centre."""
    half = 0.5 / max(reached, 1e-6)
    return (0.5 - half, 0.5 - half, 0.5 + half, 0.5 + half)


def horizontal_flip(sample: SpoofSample) -> SpoofSample:
    """Mirror both views together; a face and its context are one scene."""
    x1, y1, x2, y2 = sample.face_in_wide
    return replace(
        sample,
        tight=sample.tight[:, ::-1].copy(),
        wide=sample.wide[:, ::-1].copy(),
        face_in_wide=(1.0 - x2, y1, 1.0 - x1, y2),
    )


def narrow(wide: np.ndarray, face, reached: float, target: float) -> np.ndarray:
    """The context view recropped to `target` scale, slid to hold the face inside.

    Only shrinks what the frame already contains: padding or stretching to reach
    a scale the source never had reads as an attack cue (KEHOACH section 3).
    """
    edge = wide.shape[0]
    side = max(1, min(edge, round(edge * target / max(reached, 1e-6))))
    x1, y1, x2, y2 = (value * edge for value in face)
    left = int(min(max(0, round((x1 + x2) / 2.0 - side / 2.0)), edge - side))
    top = int(min(max(0, round((y1 + y2) / 2.0 - side / 2.0)), edge - side))
    return wide[top : top + side, left : left + side]


def narrow_tight(tight: np.ndarray, factor: float) -> np.ndarray:
    """The face view cropped about its own centre, which is where a square shorter
    than the face box takes its bite."""
    edge = tight.shape[0]
    side = max(1, min(edge, round(edge * factor)))
    offset = (edge - side) // 2
    return tight[offset : offset + side, offset : offset + side]


def crop_scale(sample: SpoofSample, target: float, size: int) -> SpoofSample:
    """Present both views at `target` scale, capped by what the frame holds.

    Below 1.0 the square is shorter than the face box, which is what a face too
    near the lens produces. Both views lose the same edge there, never one alone.
    """
    reached = min(target, sample.wide_scale)
    stored = min(1.0, sample.wide_scale)
    wide = narrow(sample.wide, sample.face_in_wide, sample.wide_scale, reached)
    tight = sample.tight if reached >= stored else narrow_tight(sample.tight, reached / stored)
    return replace(sample, tight=resized(tight, size), wide=resized(wide, size), wide_scale=reached)


def face_square(view: np.ndarray, wide_scale: float) -> tuple[int, int]:
    """Offset and side of the face box inside a view built about the face centre."""
    edge = view.shape[0]
    side = max(1, min(edge, round(edge / max(wide_scale, 1e-6))))
    return (edge - side) // 2, side


def occlude(
    sample: SpoofSample,
    rng: random.Random,
    side_range: tuple[float, float] = OCCLUSION_SIDE_RANGE,
) -> SpoofSample:
    """Cover one part of the face in both views, at the same part of the face.

    Placed in face-box coordinates rather than pixel ones, so the patch lands on
    the same feature in a crop holding the face alone and in one holding a room.
    """
    fraction = rng.uniform(*side_range)
    left, top = (rng.uniform(0.0, 1.0 - fraction) for _ in range(2))
    level = rng.randint(0, 255)
    views = []
    for view, scale in sample.scaled_views():
        out = view.copy()
        offset, side = face_square(view, scale)
        x, y = offset + int(side * left), offset + int(side * top)
        edge = max(1, int(side * fraction))
        out[y : y + edge, x : x + edge] = level
        views.append(out)
    return sample.with_views(views)


def turned(image: np.ndarray, degrees: float) -> np.ndarray:
    """One view rolled about its centre, with no corner the rotation invented.

    Mirror padding first and cropping back after keeps the corners filled with
    plausible texture; a black wedge would be a mark only rolled samples carry.
    """
    edge = image.shape[0]
    pad = edge // 2
    wider = np.pad(image, ((pad, pad), (pad, pad), (0, 0)), mode="reflect")
    spun = Image.fromarray(wider).rotate(degrees, resample=Image.BILINEAR)
    return np.array(spun, dtype=np.uint8)[pad : pad + edge, pad : pad + edge]


def roll(sample: SpoofSample, degrees: float) -> SpoofSample:
    """Roll both views by one angle, since the two crops are one scene."""
    return sample.mapped(lambda view: turned(view, degrees))


def shifted(image: np.ndarray, dx: float, dy: float) -> np.ndarray:
    """One view moved by a fraction of its own edge, mirrored where it runs out."""
    edge = image.shape[0]
    pad = max(1, edge // 4)
    wider = np.pad(image, ((pad, pad), (pad, pad), (0, 0)), mode="reflect")
    left = min(max(0, round(pad + dx * edge)), wider.shape[1] - edge)
    top = min(max(0, round(pad + dy * edge)), wider.shape[0] - edge)
    return wider[top : top + edge, left : left + edge]


def translate(sample: SpoofSample, dx: float, dy: float) -> SpoofSample:
    """Move the face off centre by one distance in the frame, seen in both views.

    The shift is a fraction of the face box, so the context view moves by fewer
    of its own pixels: the same displacement covers less of a wider crop.
    """
    span = 1.0 / max(sample.wide_scale, 1e-6)
    wide = None if sample.wide is None else shifted(sample.wide, dx * span, dy * span)
    return replace(sample, tight=shifted(sample.tight, dx, dy), wide=wide)


def requantise(image: np.ndarray, quality: int) -> np.ndarray:
    """Re-encode one view as JPEG at the given quality and decode it back."""
    buffer = io.BytesIO()
    Image.fromarray(image).save(buffer, format="JPEG", quality=quality)
    buffer.seek(0)
    with Image.open(buffer) as handle:
        return np.array(handle.convert("RGB"), dtype=np.uint8)


def recompress(sample: SpoofSample, quality: int) -> SpoofSample:
    """Put both views through one JPEG quality, so compression cannot carry the label.

    Measured: the training pool is 450x600 at a median 72 KB and the graded pool
    480x600 at 471 KB, so blocking artefacts separate the two on their own.
    """
    return sample.mapped(lambda view: requantise(view, quality))


def _clipped(values: np.ndarray) -> np.ndarray:
    return np.clip(values, 0.0, 255.0).astype(np.uint8)


@lru_cache(maxsize=4)
def _centred_grid(shape: tuple[int, int]) -> tuple[np.ndarray, np.ndarray]:
    """Coordinates running -0.5 to 0.5 across the image, y first.

    Cached because every crop of a run is one size and callers only read it.
    """
    rows, cols = shape
    axis_y = (np.arange(rows, dtype=np.float32) + 0.5) / rows - 0.5
    axis_x = (np.arange(cols, dtype=np.float32) + 0.5) / cols - 0.5
    return np.meshgrid(axis_y, axis_x, indexing="ij")


def backlight(image: np.ndarray, strength: float, angle: float) -> np.ndarray:
    """Wash one side towards white, the way a window behind the subject does."""
    grid_y, grid_x = _centred_grid(image.shape[:2])
    ramp = np.clip((grid_x * np.cos(angle) + grid_y * np.sin(angle)) + 0.5, 0.0, 1.0)
    signal = image.astype(np.float32)
    return _clipped(signal + strength * ramp[..., None] * (255.0 - signal))


def exposure(image: np.ndarray, gain: float, contrast: float) -> np.ndarray:
    """Meter the scene differently, the way a bright wall behind a face does.

    Equal gain and contrast is a pure exposure change; a contrast below the gain
    lifts the blacks the way a hazy tone curve does.
    """
    signal = image.astype(np.float32)
    return _clipped((signal - MID_LEVEL) * contrast + MID_LEVEL * gain)


def motion_blur(image: np.ndarray, length: int, angle: float) -> np.ndarray:
    """Average along one direction, the smear a moving face leaves."""
    if length < 2:
        return image
    pad = length // 2 + 1
    padded = np.pad(image, ((pad, pad), (pad, pad), (0, 0)), mode="edge").astype(np.float32)
    rows, cols = image.shape[:2]
    total = np.zeros((rows, cols, image.shape[2]), dtype=np.float32)
    for step in np.linspace(-(length - 1) / 2.0, (length - 1) / 2.0, length):
        top = pad + round(step * np.sin(angle))
        left = pad + round(step * np.cos(angle))
        total += padded[top : top + rows, left : left + cols]
    return _clipped(total / float(length))


def vignette(image: np.ndarray, strength: float) -> np.ndarray:
    """Darken towards the corners, the falloff a small lens leaves."""
    grid_y, grid_x = _centred_grid(image.shape[:2])
    falloff = 1.0 - strength * 2.0 * (grid_x**2 + grid_y**2)
    return _clipped(image.astype(np.float32) * falloff[..., None])


def sensor_noise(
    image: np.ndarray, photons: float, read_sigma: float, rng: np.random.Generator
) -> np.ndarray:
    """Shot noise scaling with signal plus constant read noise, the sensor pair.

    Shot noise is Poisson, drawn here as the gaussian of matching variance: the
    two agree to under a percent above about fifty photons, which PHOTON_RANGE
    stays above, and one normal field costs a fraction of a poisson one.
    """
    signal = image.astype(np.float32)
    sigma = np.sqrt(255.0 * signal / photons + read_sigma**2)
    return _clipped(signal + rng.standard_normal(image.shape, dtype=np.float32) * sigma)


def white_balance(image: np.ndarray, gains: np.ndarray) -> np.ndarray:
    """Per-channel gain, the colour cast an auto white balance leaves."""
    return _clipped(image.astype(np.float32) * gains)


def photometric(
    sample: SpoofSample,
    rng: random.Random,
    probability: float = PHOTOMETRIC_PROBABILITY,
    contrast_range: tuple[float, float] = EXPOSURE_CONTRAST_RANGE,
    white_balance_range: tuple[float, float] = WHITE_BALANCE_RANGE,
) -> SpoofSample:
    """Camera-path augmentation, drawn once per sample and applied to both views.

    The two crops are one scene through one lens, so a separate draw per view
    would teach the model that the pair disagrees about the light. Applied in the
    order the light meets the camera: exposure, scene, lens, sensor, processing.
    """
    views = sample.views()
    if rng.random() < probability:
        gain = rng.uniform(*EXPOSURE_GAIN_RANGE)
        contrast = rng.uniform(*contrast_range)
        views = [exposure(view, gain, contrast) for view in views]
    if rng.random() < probability:
        strength, angle = rng.uniform(*BACKLIGHT_RANGE), rng.uniform(0.0, 2.0 * np.pi)
        views = [backlight(view, strength, angle) for view in views]
    if rng.random() < probability:
        length, angle = rng.randint(*MOTION_BLUR_PX), rng.uniform(0.0, np.pi)
        views = [motion_blur(view, length, angle) for view in views]
    if rng.random() < probability:
        strength = rng.uniform(*VIGNETTE_RANGE)
        views = [vignette(view, strength) for view in views]
    if rng.random() < probability:
        photons = rng.uniform(*PHOTON_RANGE)
        read_sigma = rng.uniform(*READ_SIGMA_RANGE)
        # One stream for both views: the tight crop is the middle of the wide one,
        # so the same sensor pixels appear twice and their noise is not independent.
        seed = rng.getrandbits(32)
        views = [
            sensor_noise(view, photons, read_sigma, np.random.default_rng(seed)) for view in views
        ]
    if rng.random() < probability:
        gains = np.array([rng.uniform(*white_balance_range) for _ in range(3)], dtype=np.float32)
        views = [white_balance(view, gains) for view in views]
    return sample.with_views(views)


class SpoofShardDataset(IterableDataset):
    """Streams (tight, wide, label, wide_scale) from one split's shards."""

    def __init__(
        self,
        root: Path,
        size: int = CROP_SIZE,
        train: bool = True,
        seed: int = 42,
        shuffle_buffer: int = SHUFFLE_BUFFER,
        splits: str | Sequence[str] | None = None,
        recompress_probability: float = RECOMPRESS_PROBABILITY,
        quality_range: tuple[int, int] = QUALITY_RANGE,
        photometric_probability: float = PHOTOMETRIC_PROBABILITY,
        exposure_contrast_range: tuple[float, float] = EXPOSURE_CONTRAST_RANGE,
        white_balance_range: tuple[float, float] = WHITE_BALANCE_RANGE,
        crop_scale_range: tuple[float, float] = CROP_SCALE_RANGE,
        crop_scale_probability: float = CROP_SCALE_PROBABILITY,
        occlusion_probability: float = OCCLUSION_PROBABILITY,
        occlusion_side_range: tuple[float, float] = OCCLUSION_SIDE_RANGE,
        roll_probability: float = ROLL_PROBABILITY,
        roll_range: tuple[float, float] = ROLL_RANGE,
        translate_probability: float = TRANSLATE_PROBABILITY,
        translate_range: float = TRANSLATE_RANGE,
        keep_wide: bool = True,
    ) -> None:
        if splits is None:
            self.shards = shard_paths(root)
            if not self.shards:
                raise FileNotFoundError(f"{root}: no shard_*.tar")
            self._length = count_records(self.shards)
        else:
            self.shards, self._length = resolve_splits(root, splits)
        self.size = size
        self.train = train
        self.seed = seed
        self.keep_wide = keep_wide
        self.shuffle_buffer = shuffle_buffer if train else 0
        self.recompress_probability = recompress_probability
        self.quality_range = quality_range
        self.photometric_probability = photometric_probability
        self.crop_scale_range = crop_scale_range
        self.crop_scale_probability = crop_scale_probability
        self.exposure_contrast_range = tuple(exposure_contrast_range)
        self.white_balance_range = tuple(white_balance_range)
        self.occlusion_probability = occlusion_probability
        self.occlusion_side_range = occlusion_side_range
        self.roll_probability = roll_probability
        self.roll_range = roll_range
        self.translate_probability = translate_probability
        self.translate_range = translate_range
        self.epoch = 0

    def __len__(self) -> int:
        return self._length

    def _my_shards(self) -> list[Path]:
        """This worker's slice of the shard list.

        Without the split every worker would read every shard, so an epoch would
        train on each record num_workers times while the logs showed one pass.
        """
        info = get_worker_info()
        shards = list(self.shards)
        if self.train:
            random.Random(self.seed + self.epoch).shuffle(shards)
        if info is None:
            return shards
        return shards[info.id :: info.num_workers]

    def _records(self) -> Iterator[SpoofSample]:
        for shard in self._my_shards():
            for record in read_shard(shard):
                meta = json.loads(record["json"])
                reached = float(meta["wide_scale"])
                # The crop-scale augmentation cuts the tight view out of this one,
                # so a training pass still needs it even when the model will not see it.
                wide = decode_native(record["wide.jpg"]) if self.train or self.keep_wide else None
                if wide is not None and not self.train:
                    wide = resized(wide, self.size)
                yield SpoofSample(
                    tight=decode(record["tight.jpg"], self.size),
                    wide=wide,
                    label=int(meta["label"]),
                    wide_scale=reached,
                    face_in_wide=tuple(meta.get("face_in_wide") or centred_face(reached)),
                )

    def __iter__(self) -> Iterator[SpoofSample]:
        info = get_worker_info()
        rng = random.Random(self.seed + self.epoch + (info.id if info else 0))
        buffer: list[SpoofSample] = []
        for sample in self._records():
            if self.train and rng.random() < 0.5:
                sample = horizontal_flip(sample)
            if self.train:
                drawn = rng.random() < self.crop_scale_probability
                target = rng.uniform(*self.crop_scale_range) if drawn else sample.wide_scale
                sample = crop_scale(sample, target, self.size)
                if not self.keep_wide:
                    sample = replace(sample, wide=None)
                if rng.random() < self.translate_probability:
                    span = self.translate_range
                    sample = translate(sample, rng.uniform(-span, span), rng.uniform(-span, span))
                if rng.random() < self.roll_probability:
                    sample = roll(sample, rng.uniform(*self.roll_range))
                if rng.random() < self.occlusion_probability:
                    sample = occlude(sample, rng, self.occlusion_side_range)
                sample = photometric(
                    sample,
                    rng,
                    self.photometric_probability,
                    self.exposure_contrast_range,
                    self.white_balance_range,
                )
            if self.train and rng.random() < self.recompress_probability:
                sample = recompress(sample, rng.randint(*self.quality_range))
            if self.shuffle_buffer <= 0:
                yield sample
                continue
            buffer.append(sample)
            if len(buffer) >= self.shuffle_buffer:
                index = rng.randrange(len(buffer))
                buffer[index], buffer[-1] = buffer[-1], buffer[index]
                yield buffer.pop()
        rng.shuffle(buffer)
        yield from buffer


def chroma_of(rgb: torch.Tensor) -> torch.Tensor:
    """Per-pixel saturation, the one cue that holds its sign across lens chains.

    A convolution cannot reach it: max and min across channels are not linear,
    and the stem is linear before its activation (KEHOACH 3, measurements 38).
    """
    high = rgb.max(dim=0, keepdim=True).values
    low = rgb.min(dim=0, keepdim=True).values
    return (high - low) / high.clamp_min(1e-6)


def to_tensor(image: np.ndarray, chroma: bool = False) -> torch.Tensor:
    planes = torch.from_numpy(image).permute(2, 0, 1).float().div_(255.0)
    return torch.cat((planes, chroma_of(planes))) if chroma else planes


def collate(
    batch: list[SpoofSample],
    chroma: bool = False,
) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
    """Stack into (tight, wide, label, wide_scale), what the model and loss expect.

    A one-backbone run carries no context view, and the empty stand-in keeps the
    tuple the same shape for every caller.
    """
    tight = torch.stack([to_tensor(s.tight, chroma) for s in batch])
    wide = (
        torch.stack([to_tensor(s.wide, chroma) for s in batch])
        if batch[0].wide is not None
        else tight[:0]
    )
    labels = torch.tensor([s.label for s in batch], dtype=torch.long)
    scales = torch.tensor([s.wide_scale for s in batch], dtype=torch.float32)
    return tight, wide, labels, scales
