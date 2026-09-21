#!/usr/bin/env python3
"""Run EXPLAIN over the reads that touch a big table (KEHOACH 9.22.5).

A sequential scan on a table above its floor fails unless WHY names a reason.
Below the floor the verdict is withheld: EXPLAIN over a seven-row table always
picks a sequential scan and that says nothing about a missing index.
Needs DATABASE_URL, which backend/.env already carries.
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
from pathlib import Path

ENV_FILE = Path("backend/.env")

# Below this many live rows the planner's choice carries no information, so the
# verdict is withheld (KEHOACH 9.22.5).
FLOORS: dict[str, int] = {
    "Employee": 1000,
    "AttendanceRecord": 1000,
    "AttendanceDay": 1000,
    "Payslip": 1000,
    "PayslipLine": 1000,
    "AuditLog": 1000,
    "Request": 1000,
    "Notification": 1000,
    "DocumentAck": 1000,
    "PersonnelFile": 1000,
}

# A read that a growing company runs often enough to matter. Each one is the
# shape the service sends, with literals where it binds parameters.
QUERIES: dict[str, str] = {
    "attendance-day-range": """
        SELECT "employeeId", sum("workedMinutes") FROM "AttendanceDay"
         WHERE "date" BETWEEN '2026-09-01' AND '2026-09-30'
         GROUP BY "employeeId"
    """,
    "payslip-of-period": """
        SELECT * FROM "Payslip" WHERE "periodId" = '00000000-0000-0000-0000-000000000000'
    """,
    "payslip-lines-of-slip": """
        SELECT * FROM "PayslipLine"
         WHERE "payslipId" = '00000000-0000-0000-0000-000000000000' ORDER BY "ordinal"
    """,
    "payslip-year-of-person": """
        SELECT * FROM "Payslip" WHERE "employeeId" = 1 AND "state" IN ('ISSUED', 'SENT', 'VIEWED')
    """,
    "audit-of-subject": """
        SELECT * FROM "AuditLog" WHERE "subjectType" = 'employee' AND "subjectId" = '1'
         ORDER BY "ts" DESC LIMIT 50
    """,
    "requests-waiting-on-me": """
        SELECT * FROM "Request" WHERE "state" = 'PENDING' AND "approverId" = 1
    """,
    "requests-at-a-mark": """
        SELECT r."id" FROM "Request" r
         WHERE r."state" = 'PENDING' AND r."approverId" IS NOT NULL
           AND (CURRENT_DATE - r."createdAt"::date) = ANY(ARRAY[3, 7, 14]::int[])
    """,
    "unread-notifications": """
        SELECT count(*) FROM "Notification" WHERE "employeeId" = 1 AND "readAt" IS NULL
    """,
    "leavers-of-period": """
        SELECT e."id" FROM "Employee" e
         WHERE e."leaveDate" >= '2026-09-01' AND e."leaveDate" <= '2026-09-30'
    """,
    "documents-for-one-person": """
        SELECT d."id" FROM "Document" d JOIN "Employee" e ON e."id" = 1
         WHERE d."active" = true
           AND (d."departmentId" IS NULL OR d."departmentId" = e."departmentId")
           AND (d."jobTitleId" IS NULL OR d."jobTitleId" = e."jobTitleId")
    """,
    "personnel-file-gaps": """
        SELECT e."id" FROM "Employee" e
         CROSS JOIN "PersonnelFileType" t
          LEFT JOIN "PersonnelFile" f ON f."employeeId" = e."id" AND f."typeId" = t."id"
         WHERE e."active" = true AND t."active" = true AND t."required" = true
           AND (f."id" IS NULL OR (f."expiresAt" IS NOT NULL AND f."expiresAt" < CURRENT_DATE))
    """,
}

# A scan that is meant to be a scan, and why. Anything not named here must use
# an index once its table is above the floor.
WHY: dict[tuple[str, str], str] = {
    ("personnel-file-gaps", "Employee"): (
        "every working person is a candidate by definition, so the scan is the question"
    ),
    ("attendance-day-range", "AttendanceDay"): (
        "a whole month of one partition is most of it; the partition is the index"
    ),
    ("documents-for-one-person", "Document"): (
        "one row per policy, a few dozen at company scale, and it never grows with headcount"
    ),
}

SCAN = re.compile(r"Seq Scan on (?:\w+ )?\"?(\w+)\"?", re.I)


def psql(url: str, sql: str) -> str:
    """Run one statement through the client inside the postgres container."""
    done = subprocess.run(
        ["docker", "compose", "-f", "deploy/docker-compose.yml", "exec", "-T", "postgres",
         "psql", "-qAtX", url, "-c", sql],
        capture_output=True,
        text=True,
        check=False,
    )
    if done.returncode != 0:
        raise RuntimeError(done.stderr.strip() or "psql failed")
    return done.stdout


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


def live_rows(url: str) -> dict[str, int]:
    out = psql(url, 'SELECT relname, n_live_tup FROM pg_stat_user_tables')
    counts: dict[str, int] = {}
    for line in out.splitlines():
        if "|" in line:
            name, held = line.split("|", 1)
            counts[name.strip()] = int(held.strip() or 0)
    return counts


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--show", action="store_true", help="print every plan, not only the faults")
    args = parser.parse_args()

    try:
        url = read_url()
        counts = live_rows(url)
    except (OSError, RuntimeError) as fell:
        print(f"check_plans: cannot reach the database: {fell}", file=sys.stderr)
        return 2

    faults = 0
    withheld = 0
    for name, sql in sorted(QUERIES.items()):
        try:
            plan = psql(url, f"EXPLAIN {sql.strip()}")
        except RuntimeError as fell:
            print(f"{name}: EXPLAIN failed: {fell}")
            faults += 1
            continue
        if args.show:
            print(f"--- {name}\n{plan.rstrip()}")
        for table in sorted(set(SCAN.findall(plan))):
            floor = FLOORS.get(table)
            if floor is None:
                continue
            held = counts.get(table, 0)
            if (name, table) in WHY:
                continue
            if held < floor:
                print(f"{name}: seq scan on {table}, {held} rows is under the {floor} floor — no verdict")
                withheld += 1
                continue
            print(f"{name}: seq scan on {table} at {held} rows, and no reason is recorded")
            faults += 1

    print(f"check_plans: {len(QUERIES)} query(s), {faults} problem(s), {withheld} withheld")
    return 1 if faults else 0


if __name__ == "__main__":
    sys.exit(main())
