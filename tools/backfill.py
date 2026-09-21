#!/usr/bin/env python3
"""Move data in batches, one transaction each (KEHOACH 9.22.3).

--where picks the rows not yet done and --set must make them stop matching;
that shrinking is what lets a stopped run resume with no cursor kept anywhere.
Dry by default. Needs DATABASE_URL, which backend/.env already carries.
"""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
from pathlib import Path

ENV_FILE = Path("backend/.env")
COMPOSE = ["docker", "compose", "-f", "deploy/docker-compose.yml"]


def psql(url: str, sql: str) -> str:
    done = subprocess.run(
        [*COMPOSE, "exec", "-T", "postgres", "psql", "-qAtX", url, "-c", sql],
        capture_output=True,
        text=True,
        check=False,
    )
    if done.returncode != 0:
        raise RuntimeError(done.stderr.strip() or "psql failed")
    return done.stdout.strip()


def read_url() -> str:
    held = os.environ.get("DATABASE_URL")
    if not held:
        for line in ENV_FILE.read_text(encoding="utf-8").splitlines():
            if line.startswith("DATABASE_URL="):
                held = line.split("=", 1)[1].strip().strip('"')
                break
    if not held:
        raise RuntimeError(f"no DATABASE_URL in the environment or {ENV_FILE}")
    # `?schema=` is Prisma's; libpq refuses a query parameter it does not know.
    return held.split("?", 1)[0]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--table", required=True)
    parser.add_argument("--key", required=True, help="an ordered column the batch walks")
    parser.add_argument("--set", required=True, dest="assign", help="the SET clause, without SET")
    parser.add_argument("--where", required=True, help="what is not yet done; --set must clear it")
    parser.add_argument("--chunk", type=int, default=5000)
    parser.add_argument("--pause-ms", type=int, default=200, help="room for other writers between batches")
    parser.add_argument("--apply", action="store_true", help="write; the default only reports")
    args = parser.parse_args()

    table = f'"{args.table}"'
    key = f'"{args.key}"' if not args.key.startswith('"') else args.key
    batch = (
        f"WITH batch AS ("
        f"  SELECT {key} FROM {table} WHERE {args.where}"
        f"  ORDER BY {key} LIMIT {args.chunk} FOR UPDATE SKIP LOCKED)"
        f" UPDATE {table} t SET {args.assign} FROM batch b WHERE t.{key} = b.{key}"
    )

    try:
        url = read_url()
        left = int(psql(url, f"SELECT count(*) FROM {table} WHERE {args.where}"))
    except (OSError, RuntimeError, ValueError) as fell:
        print(f"backfill: {fell}", file=sys.stderr)
        return 2

    if left == 0:
        print(f"backfill: nothing in {args.table} matches; already done")
        return 0

    rounds = -(-left // args.chunk)
    print(f"backfill: {left} row(s) in {args.table}, {rounds} batch(es) of {args.chunk}")
    if not args.apply:
        print(psql(url, f"EXPLAIN {batch}"))
        print("backfill: dry run, nothing written; pass --apply to write")
        return 0

    started = time.monotonic()
    done = 0
    while left > 0:
        psql(url, batch)
        after = int(psql(url, f"SELECT count(*) FROM {table} WHERE {args.where}"))
        moved = left - after
        if moved <= 0:
            # Rewriting the same rows forever is quieter than an error, so it
            # is the one thing this stops on (KEHOACH 9.22.3).
            print(
                f"backfill: {after} row(s) still match after a batch; "
                "--set does not clear --where, so this would never end",
                file=sys.stderr,
            )
            return 1
        done += moved
        left = after
        print(f"backfill: {done} done, {left} left")
        if left > 0 and args.pause_ms > 0:
            time.sleep(args.pause_ms / 1000)

    took = time.monotonic() - started
    rate = done / took if took > 0 else 0
    print(f"backfill: {done} row(s) in {took:.1f}s, {rate:.0f} row/s")
    return 0


if __name__ == "__main__":
    sys.exit(main())
