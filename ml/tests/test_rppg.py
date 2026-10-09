"""E6-T11/T12: rPPG pulse, skin regions, the board path and the split (KEHOACH 3)."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pytest

from facepipe.data.make_split import build_rppg
from facepipe.tasks.rppg.board_path import rgb565_levels
from facepipe.tasks.rppg.config import Region, load_config
from facepipe.tasks.rppg.data import axon_clips, unique_clips
from facepipe.tasks.rppg.eval import auc, gate, summarise
from facepipe.tasks.rppg.pulse import pulse_of, uniform
from facepipe.tasks.rppg.roi import region_boxes, region_means
from facepipe.tasks.rppg.spectrum import peak_halfwidth, peak_snr, power_spectrum

CFG = load_config(Path(__file__).resolve().parents[1] / "configs/rppg/rppg.yaml")
FS = CFG.board_fps
RATE_HZ = 1.2
SKIN = np.array([0.62, 0.45, 0.36])
# Direction a pulse moves normalised skin colour in, Wang et al. 2017.
PULSE_DIRECTION = np.array([0.33, 0.77, 0.53])


def skin_series(seconds: float, amplitude: float, seed: int = 0) -> np.ndarray:
    """Mean skin colour with a pulse, a slow light drift and per-frame noise."""
    rng = np.random.default_rng(seed)
    t = np.arange(round(seconds * FS)) / FS
    pulse = amplitude * np.sin(2 * np.pi * RATE_HZ * t)[:, None] * PULSE_DIRECTION
    drift = 1.0 + 0.02 * np.sin(2 * np.pi * 0.1 * t)[:, None]
    return SKIN * drift * (1.0 + pulse) + rng.normal(0.0, 5e-4, (len(t), 3))


def rate_and_snr(series: np.ndarray, method: str) -> tuple[float, float]:
    signal = pulse_of(method, series, FS, CFG.band_hz, CFG.pos_window_s)
    freqs, power = power_spectrum(signal, FS, CFG.nfft)
    halfwidth = peak_halfwidth(len(series) / FS, CFG.peak_halfwidth_hz)
    return peak_snr(freqs, power, CFG.band_hz, halfwidth)


@pytest.mark.parametrize("method", ["green", "chrom", "pos"])
def test_every_method_reads_72_bpm_from_a_half_percent_pulse(method: str) -> None:
    bpm, snr = rate_and_snr(skin_series(8.0, 0.005), method)
    assert abs(bpm - 72.0) <= 1.0
    assert snr > rate_and_snr(skin_series(8.0, 0.0), method)[1] + 5.0


@pytest.mark.parametrize("method", ["green", "chrom", "pos"])
def test_the_pulse_survives_board_noise_and_rgb565(method: str) -> None:
    rng = np.random.default_rng(1)
    clean = skin_series(8.0, 0.005)
    # A shaded patch, so pixels sit at different distances from a quantisation step.
    shade = np.linspace(0.85, 1.15, 32)[None, :, None] * np.linspace(0.9, 1.1, 32)[:, None, None]
    means = []
    for colour in clean:
        patch = np.clip(np.round(255.0 * colour * shade), 0, 255).astype(np.uint8)
        means.append(rgb565_levels(patch, CFG.board_noise_lsb, rng).reshape(-1, 3).mean(axis=0))
    bpm, _ = rate_and_snr(np.array(means), method)
    assert abs(bpm - 72.0) <= 1.0


def test_rgb565_levels_truncate_each_channel_to_its_own_depth() -> None:
    image = np.array([[[255, 255, 255], [0, 0, 0], [12, 12, 12]]], dtype=np.uint8)
    levels = rgb565_levels(image, 0.0, np.random.default_rng(0))
    assert np.allclose(levels[0, 0], 1.0)
    assert np.allclose(levels[0, 1], 0.0)
    assert np.allclose(levels[0, 2], [1 / 31, 3 / 63, 1 / 31])


def test_uniform_resamples_uneven_times_onto_the_grid() -> None:
    t = np.array([0.0, 0.05, 0.2, 0.31])
    rgb = np.stack([t, 2 * t, 3 * t], axis=1)
    out = uniform(t, rgb, 10.0)
    assert out.shape == (4, 3)
    assert np.allclose(out[:, 1], 2 * np.arange(4) / 10.0)


def test_regions_sit_above_and_below_the_eyes_and_scale_with_them() -> None:
    eyes_mouth = np.array([[40, 50], [60, 50], [50, 60], [43, 70], [57, 70]], dtype=float)
    boxes = region_boxes(eyes_mouth, CFG.regions)
    forehead, left, right = boxes
    assert forehead[3] < 50 < left[1]
    assert left[2] < 50 < right[0]
    double = region_boxes(eyes_mouth * 2, CFG.regions)
    assert np.allclose(double, boxes * 2)


def test_region_means_are_nan_once_a_region_leaves_the_frame() -> None:
    image = np.full((20, 20, 3), 100, dtype=np.uint8)
    boxes = np.array([[2, 2, 10, 10], [15, 15, 40, 40]], dtype=float)
    means = region_means(image, boxes)
    assert np.allclose(means[0], 100)
    assert np.isnan(means[1]).all()


def test_a_region_from_config_has_a_centre_and_size() -> None:
    assert isinstance(CFG.regions["forehead"], Region)
    assert set(CFG.methods) == {"green", "chrom", "pos"}


def test_axon_maps_every_video_folder_to_a_class(tmp_path: Path) -> None:
    for relative in (
        "Cutout_attacks/104.MOV",
        "Textile 3D Face Mask Attack Sample/id1/iPhone14Pro/a.mp4",
        "Selfies/still.jpg",
    ):
        (tmp_path / relative).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / relative).write_bytes(b"")
    clips = {clip.source: clip for clip in axon_clips(tmp_path)}
    assert clips["axon_cutout_attacks"].kind == "paper"
    assert clips["axon_textile_3d_face_mask_attack_sample"].kind == "mask"
    assert clips["axon_textile_3d_face_mask_attack_sample"].name == "id1_iphone14pro_a"
    (tmp_path / "Unknown_folder").mkdir()
    (tmp_path / "Unknown_folder/x.mp4").write_bytes(b"")
    with pytest.raises(ValueError, match="no class"):
        axon_clips(tmp_path)


def test_axon_is_read_through_the_folder_links_data_raw_is_made_of(tmp_path: Path) -> None:
    store, linked = tmp_path / "store/Latex_mask", tmp_path / "raw"
    store.mkdir(parents=True)
    (store / "m.mp4").write_bytes(b"")
    linked.mkdir()
    (linked / "Latex_mask").symlink_to(store, target_is_directory=True)
    assert [clip.kind for clip in axon_clips(linked)] == ["mask"]


def unique_tree(root: Path) -> None:
    rows = [("l1", "r1", "w1", ".mp4"), ("l2", "r2", "w2", ".MOV"), ("l3", "r3", "w1", ".mp4")]
    rows += [("l4", "r4", "w3", ".3gp"), ("l5", "r5", "w4", ".mp4")]
    lines = ["live_video_id;phone;link;phone_video_playback;worker_id"]
    for live, replay, worker, suffix in rows:
        (root / "live" / live).mkdir(parents=True)
        (root / "live" / live / f"live_video{suffix}").write_bytes(b"")
        (root / "replay" / replay).mkdir(parents=True)
        (root / "replay" / replay / "replay_video.mp4").write_bytes(b"")
        lines.append(f"{live};phone;{replay}/replay_video.mp4;player;{worker}")
    (root / "anti-spoofing_replay.csv").write_text("\n".join(lines) + "\n", encoding="utf-8")


def test_unique_clips_pair_each_worker_and_skip_formats_never_read(tmp_path: Path) -> None:
    unique_tree(tmp_path)
    clips = unique_clips(tmp_path)
    live = {clip.name: clip.person for clip in clips if clip.kind == "live"}
    assert live == {"live_l1": "w1", "live_l2": "w2", "live_l3": "w1", "live_l5": "w4"}
    assert sum(clip.kind == "replay" for clip in clips) == 5


def test_rppg_split_never_puts_one_worker_on_both_sides(tmp_path: Path) -> None:
    unique_tree(tmp_path)
    parts = build_rppg(tmp_path, seed=42)
    people = {clip.name: clip.person for clip in unique_clips(tmp_path)}
    dev = {people[name] for name in parts["dev_live.txt"]}
    test = {people[name] for name in parts["test_live.txt"]}
    assert not dev & test
    assert sorted(parts["dev_live.txt"] + parts["test_live.txt"]) == sorted(
        name for name in people if name.startswith("live_")
    )
    assert build_rppg(tmp_path, seed=42) == parts


def test_threshold_comes_from_dev_live_and_rates_follow_it() -> None:
    rows = []
    for index, snr in enumerate([5.0, 6.0, 7.0, 8.0, 9.0] * 4):
        rows.append(
            {
                "path": "board_100",
                "method": "pos",
                "T": 4.0,
                "kind": "live",
                "split": "dev",
                "snr_db": snr,
                "clip": f"d{index}",
            }
        )
    rows += [
        {
            "path": "board_100",
            "method": "pos",
            "T": 4.0,
            "kind": "live",
            "split": "test",
            "snr_db": s,
            "clip": "t",
        }
        for s in (4.0, 8.0)
    ]
    rows += [
        {
            "path": "board_100",
            "method": "pos",
            "T": 4.0,
            "kind": "paper",
            "split": "attack",
            "snr_db": s,
            "clip": "p",
        }
        for s in (1.0, 2.0, 9.5)
    ]
    line = summarise(rows, CFG)[0]
    assert line["threshold_db"] == pytest.approx(
        np.quantile([5.0, 6.0, 7.0, 8.0, 9.0] * 4, CFG.target_bpcer)
    )
    assert line["bpcer_test"] == pytest.approx(0.5)
    assert line["apcer_paper"] == pytest.approx(1 / 3)
    assert gate([line]) == []
    assert auc(np.array([3.0, 4.0]), np.array([1.0, 4.0])) == pytest.approx(0.625)
