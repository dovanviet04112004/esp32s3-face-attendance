"""Liveness from pulse SNR on PC, scored as KEHOACH 3 fixed before measuring.

Sliding windows of every trace are scored by each method; the SNR threshold comes from
dev live windows alone, and is then held against test live windows and every attack
window by class. One immutable folder per run under rppg.eval in paths.yaml.
"""

from __future__ import annotations

import argparse
import csv
import json
import subprocess
from datetime import datetime
from pathlib import Path

import numpy as np
import yaml

from .config import RppgConfig, data_path, load_config
from .pulse import pulse_of, uniform
from .spectrum import peak_halfwidth, peak_snr, power_spectrum

SPLIT_DIR = Path("data/splits/rppg/v1")
ATTACK_KINDS = ("paper", "mask", "replay")
# The gate of KEHOACH 3: on this path, some window up to this long must pass both rates.
GATE_PATH = "board_100"
GATE_MAX_T = 6.0
GATE_APCER_PAPER = 0.10
GATE_BPCER_TEST = 0.10


def read_trace(path: Path) -> dict:
    with np.load(path) as data:
        return {key: data[key].item() if data[key].ndim == 0 else data[key] for key in data.files}


def sampling_rate(trace: dict, path_name: str, cfg: RppgConfig) -> float:
    return float(trace["fps_source"]) if path_name == "native" else cfg.board_fps


def skin_series(trace: dict, fs: float) -> np.ndarray | None:
    """The regions averaged into one colour series on a uniform grid; None if too short."""
    t, rgb = trace["t"], trace["rgb"]
    if len(t) < 2:
        return None
    with np.errstate(invalid="ignore"):
        mean = np.nanmean(rgb, axis=1)
    keep = ~np.isnan(mean).any(axis=1)
    if keep.sum() < 2:
        return None
    return uniform(t[keep], mean[keep], fs)


def window_scores(
    series: np.ndarray, fs: float, method: str, seconds: float, cfg: RppgConfig
) -> list[tuple[float, float, float]]:
    """(start s, bpm, SNR dB) of each window of `seconds`, stepping by the configured stride."""
    length, step = round(seconds * fs), max(round(cfg.stride_s * fs), 1)
    rows = []
    for start in range(0, len(series) - length + 1, step):
        chunk = series[start : start + length]
        pulse = pulse_of(method, chunk, fs, cfg.band_hz, cfg.pos_window_s)
        freqs, power = power_spectrum(pulse, fs, cfg.nfft)
        halfwidth = peak_halfwidth(seconds, cfg.peak_halfwidth_hz)
        bpm, snr = peak_snr(freqs, power, cfg.band_hz, halfwidth)
        rows.append((start / fs, bpm, snr))
    return rows


def auc(live: np.ndarray, attack: np.ndarray) -> float:
    """Chance a live window outscores an attack window, ties counting half."""
    if not len(live) or not len(attack):
        return float("nan")
    greater = (live[:, None] > attack[None, :]).mean()
    ties = (live[:, None] == attack[None, :]).mean()
    return float(greater + 0.5 * ties)


def split_of(name: str, dev: set[str], test: set[str]) -> str:
    return "dev" if name in dev else "test" if name in test else "unsplit"


def summarise(rows: list[dict], cfg: RppgConfig) -> list[dict]:
    """One line per (path, method, T): threshold from dev live, then the rates it gives."""
    groups: dict[tuple[str, str, float], list[dict]] = {}
    for row in rows:
        groups.setdefault((row["path"], row["method"], row["T"]), []).append(row)
    out = []
    for (path_name, method, seconds), members in sorted(groups.items()):
        dev = np.array(
            [r["snr_db"] for r in members if r["kind"] == "live" and r["split"] == "dev"]
        )
        test = np.array(
            [r["snr_db"] for r in members if r["kind"] == "live" and r["split"] == "test"]
        )
        live = np.array([r["snr_db"] for r in members if r["kind"] == "live"])
        if not len(dev):
            continue
        threshold = float(np.quantile(dev, cfg.target_bpcer))
        line = {
            "path": path_name,
            "method": method,
            "T": seconds,
            "threshold_db": threshold,
            "live_windows": {"dev": len(dev), "test": len(test)},
            "bpcer_test": float((test < threshold).mean()) if len(test) else float("nan"),
        }
        for kind in ATTACK_KINDS:
            attack = np.array([r["snr_db"] for r in members if r["kind"] == kind])
            line[f"{kind}_windows"] = len(attack)
            line[f"apcer_{kind}"] = (
                float((attack >= threshold).mean()) if len(attack) else float("nan")
            )
            line[f"auc_{kind}"] = auc(live, attack)
        out.append(line)
    return out


def gate(summary: list[dict]) -> list[dict]:
    return [
        line
        for line in summary
        if line["path"] == GATE_PATH
        and line["T"] <= GATE_MAX_T
        and line["apcer_paper"] <= GATE_APCER_PAPER
        and line["bpcer_test"] <= GATE_BPCER_TEST
    ]


def git_short() -> str:
    try:
        return subprocess.run(
            ["git", "rev-parse", "--short=7", "HEAD"], capture_output=True, text=True, check=True
        ).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return "nogit"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cfg", type=Path, default=Path("configs/rppg/rppg.yaml"))
    parser.add_argument(
        "--paths", nargs="*", default=None, help="trace paths to score; all by default"
    )
    args = parser.parse_args(argv)

    cfg = load_config(args.cfg)
    dev = set((SPLIT_DIR / "dev_live.txt").read_text(encoding="utf-8").split())
    test = set((SPLIT_DIR / "test_live.txt").read_text(encoding="utf-8").split())
    root = data_path("rppg.traces")
    path_names = args.paths or sorted(p.name for p in root.iterdir() if p.is_dir())

    rows: list[dict] = []
    for path_name in path_names:
        for file in sorted((root / path_name).rglob("*.npz")):
            trace = read_trace(file)
            fs = sampling_rate(trace, path_name, cfg)
            series = skin_series(trace, fs)
            if series is None:
                continue
            name = file.stem
            for method in cfg.methods:
                for seconds in cfg.windows_s:
                    for start, bpm, snr in window_scores(series, fs, method, seconds, cfg):
                        rows.append(
                            {
                                "path": path_name,
                                "method": method,
                                "T": float(seconds),
                                "clip": name,
                                "kind": str(trace["kind"]),
                                "source": str(trace["source"]),
                                "split": split_of(name, dev, test)
                                if trace["kind"] == "live"
                                else "attack",
                                "start_s": round(start, 3),
                                "bpm": bpm,
                                "snr_db": snr,
                            }
                        )

    summary = summarise(rows, cfg)
    out = data_path("rppg.eval") / f"{datetime.now():%Y%m%d-%H%M}_{git_short()}"
    out.mkdir(parents=True, exist_ok=False)
    (out / "config.resolved.yaml").write_text(
        yaml.safe_dump(cfg.model_dump(mode="json"), sort_keys=False), encoding="utf-8"
    )
    with (out / "windows.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=list(rows[0]) if rows else ["path"])
        writer.writeheader()
        writer.writerows(rows)
    passing = gate(summary)
    (out / "summary.json").write_text(
        json.dumps({"summary": summary, "gate_passes": passing}, indent=1), encoding="utf-8"
    )

    print("| path | method | T | thr dB | BPCER test | APCER paper | mask | replay | AUC paper |")
    print("|---|---|---|---|---|---|---|---|---|")
    for line in summary:
        print(
            f"| {line['path']} | {line['method']} | {line['T']:g} | {line['threshold_db']:.2f} | "
            f"{line['bpcer_test']:.3f} | {line['apcer_paper']:.3f} | {line['apcer_mask']:.3f} | "
            f"{line['apcer_replay']:.3f} | {line['auc_paper']:.3f} |"
        )
    verdict = "PASS" if passing else "FAIL"
    print(f"gate ({GATE_PATH}, T <= {GATE_MAX_T:g} s): {verdict}, {len(passing)} line(s)")
    print(f"written to {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
