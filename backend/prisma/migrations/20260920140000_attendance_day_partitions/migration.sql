-- Expand step (KEHOACH 9.22.3): the old table is renamed and kept, not dropped.
-- A later release drops it, once this one has run somewhere real.
ALTER TABLE "AttendanceDay" RENAME TO "AttendanceDay_flat";
ALTER INDEX "AttendanceDay_employeeId_date_key" RENAME TO "AttendanceDay_flat_employeeId_date_key";
ALTER INDEX "AttendanceDay_date_idx" RENAME TO "AttendanceDay_flat_date_idx";
ALTER INDEX "AttendanceDay_employeeId_date_idx" RENAME TO "AttendanceDay_flat_employeeId_date_idx";
ALTER INDEX "AttendanceDay_pkey" RENAME TO "AttendanceDay_flat_pkey";
ALTER TABLE "AttendanceDay_flat" RENAME CONSTRAINT "AttendanceDay_minutes_not_negative"
    TO "AttendanceDay_flat_minutes_not_negative";
ALTER TABLE "AttendanceDay_flat" RENAME CONSTRAINT "AttendanceDay_employeeId_fkey"
    TO "AttendanceDay_flat_employeeId_fkey";
ALTER SEQUENCE "AttendanceDay_id_seq" RENAME TO "AttendanceDay_flat_id_seq";

CREATE TABLE "AttendanceDay" (
    "id"                BIGSERIAL    NOT NULL,
    "employeeId"        INTEGER      NOT NULL,
    "date"              DATE         NOT NULL,
    "state"             "DayState"   NOT NULL DEFAULT 'ABSENT',
    "shiftId"           TEXT,
    "firstIn"           TIMESTAMP(3),
    "lastOut"           TIMESTAMP(3),
    "workedMinutes"     INTEGER      NOT NULL DEFAULT 0,
    "lateMinutes"       INTEGER      NOT NULL DEFAULT 0,
    "earlyLeaveMinutes" INTEGER      NOT NULL DEFAULT 0,
    "overtimeMinutes"   INTEGER      NOT NULL DEFAULT 0,
    "punchCount"        INTEGER      NOT NULL DEFAULT 0,
    "clockUnsynced"     BOOLEAN      NOT NULL DEFAULT false,
    "measuredMinutes"   INTEGER,
    "adjustedById"      TEXT,
    "adjustReason"      TEXT,
    "adjustedAt"        TIMESTAMP(3),
    "builtAt"           TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL,
    -- The partition key has to be in every unique key, and date already was.
    CONSTRAINT "AttendanceDay_pkey" PRIMARY KEY ("id", "date")
) PARTITION BY RANGE ("date");

-- Creating months up front rather than on demand: a write that lands with no
-- partition fails, and payroll is the wrong place to discover that.
DO $$
DECLARE
    at   DATE := DATE '2026-01-01';
    stop DATE := DATE '2028-01-01';
BEGIN
    WHILE at < stop LOOP
        EXECUTE format(
            'CREATE TABLE %I PARTITION OF "AttendanceDay" FOR VALUES FROM (%L) TO (%L)',
            'AttendanceDay_' || to_char(at, 'YYYYMM'), at, at + INTERVAL '1 month');
        at := at + INTERVAL '1 month';
    END LOOP;
END $$;

INSERT INTO "AttendanceDay" (
    "id", "employeeId", "date", "state", "shiftId", "firstIn", "lastOut",
    "workedMinutes", "lateMinutes", "earlyLeaveMinutes", "overtimeMinutes",
    "punchCount", "clockUnsynced", "measuredMinutes", "adjustedById",
    "adjustReason", "adjustedAt", "builtAt", "updatedAt")
SELECT "id", "employeeId", "date", "state", "shiftId", "firstIn", "lastOut",
       "workedMinutes", "lateMinutes", "earlyLeaveMinutes", "overtimeMinutes",
       "punchCount", "clockUnsynced", "measuredMinutes", "adjustedById",
       "adjustReason", "adjustedAt", "builtAt", "updatedAt"
  FROM "AttendanceDay_flat";

SELECT setval(
    pg_get_serial_sequence('"AttendanceDay"', 'id'),
    GREATEST((SELECT COALESCE(MAX("id"), 1) FROM "AttendanceDay"), 1));

CREATE UNIQUE INDEX "AttendanceDay_employeeId_date_key"
    ON "AttendanceDay" ("employeeId", "date");
CREATE INDEX "AttendanceDay_date_idx" ON "AttendanceDay" ("date");
CREATE INDEX "AttendanceDay_employeeId_date_idx" ON "AttendanceDay" ("employeeId", "date");

ALTER TABLE "AttendanceDay"
    ADD CONSTRAINT "AttendanceDay_employeeId_fkey"
    FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "AttendanceDay"
    ADD CONSTRAINT "AttendanceDay_minutes_not_negative" CHECK (
        "workedMinutes" >= 0 AND "lateMinutes" >= 0
        AND "earlyLeaveMinutes" >= 0 AND "overtimeMinutes" >= 0 AND "punchCount" >= 0
    );
