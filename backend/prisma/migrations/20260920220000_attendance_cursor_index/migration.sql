-- The cursor compares (ts, id) as a pair, and an index on ts alone makes
-- Postgres walk every row above the cursor and filter it out again.
DROP INDEX "AttendanceRecord_ts_idx";
CREATE INDEX "AttendanceRecord_ts_id_idx" ON "AttendanceRecord"("ts", "id");

DROP INDEX "AttendanceRecord_employeeId_ts_idx";
CREATE INDEX "AttendanceRecord_employeeId_ts_id_idx" ON "AttendanceRecord"("employeeId", "ts", "id");
