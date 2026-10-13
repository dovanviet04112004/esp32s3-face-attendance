-- The error code a failed run stopped on, for the period page to explain it (KEHOACH 9.6).
ALTER TABLE "PayrollRun" ADD COLUMN "failure" TEXT;
