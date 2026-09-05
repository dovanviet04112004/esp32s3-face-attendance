"""Index the self-captured OV5640 images into manifest.csv.

Filenames follow <session>_<seq>.jpg and each image may carry a sibling json in
meta/ holding the capture conditions. Whatever the json does not say is left
empty rather than guessed: a fabricated lux value would end up in the report.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
from dataclasses import asdict, dataclass, fields
from pathlib import Path

FILENAME_RE = re.compile(r"^(?P<session>[A-Za-z0-9-]+)_(?P<seq>\d+)$")
IMAGE_SUFFIXES = {".jpg", ".jpeg", ".png"}


@dataclass
class Row:
    """One row of manifest.csv, columns fixed by KEHOACH 4.4.2."""

    file: str
    person_id: str = ""
    session: str = ""
    lighting: str = ""
    distance_cm: str = ""
    is_spoof: str = "0"
    spoof_type: str = ""
    capture_date: str = ""


def parse_name(stem: str) -> tuple[str, str]:
    match = FILENAME_RE.match(stem)
    if match is None:
        return "", ""
    return match["session"], match["seq"]


def read_meta(meta_dir: Path, stem: str) -> dict:
    path = meta_dir / f"{stem}.json"
    if not path.is_file():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return {}
    return payload if isinstance(payload, dict) else {}


def build_rows(root: Path) -> tuple[list[Row], list[str]]:
    """Scan images/ and pair each with meta/, reporting names that do not parse."""
    images_dir = root / "images"
    meta_dir = root / "meta"
    if not images_dir.is_dir():
        raise FileNotFoundError(f"{images_dir} does not exist")

    rows: list[Row] = []
    unparsed: list[str] = []
    for path in sorted(images_dir.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in IMAGE_SUFFIXES:
            continue
        stem = path.stem
        session, _seq = parse_name(stem)
        if not session:
            unparsed.append(path.name)
        meta = read_meta(meta_dir, stem)
        rows.append(
            Row(
                file=str(path.relative_to(root)),
                person_id=str(meta.get("person_id", "")),
                session=session or str(meta.get("session", "")),
                lighting=str(meta.get("lighting", meta.get("lux", ""))),
                distance_cm=str(meta.get("distance_cm", "")),
                is_spoof="1" if meta.get("is_spoof") else "0",
                spoof_type=str(meta.get("spoof_type", "")),
                capture_date=str(meta.get("capture_date", "")),
            )
        )
    return rows, unparsed


def write_manifest(root: Path, rows: list[Row]) -> Path:
    target = root / "manifest.csv"
    with target.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=[f.name for f in fields(Row)])
        writer.writeheader()
        for row in rows:
            writer.writerow(asdict(row))
    return target


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path("data/raw/device/ov5640"))
    args = parser.parse_args(argv)

    rows, unparsed = build_rows(args.root)
    target = write_manifest(args.root, rows)
    live = sum(1 for row in rows if row.is_spoof == "0")
    missing_person = sum(1 for row in rows if not row.person_id)

    print(f"{target}: {len(rows)} image(s), {live} live, {len(rows) - live} spoof")
    if unparsed:
        print(f"  {len(unparsed)} filename(s) do not match <session>_<seq>: {unparsed[:5]}")
    if missing_person:
        print(f"  {missing_person} row(s) have no person_id; splits cannot be identity-disjoint")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
