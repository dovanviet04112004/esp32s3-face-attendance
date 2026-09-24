-- The span a kiosk spent revoked, whose punches never enter the timesheet
-- (KEHOACH 7.3).
ALTER TABLE "Device" ADD COLUMN "revokedAt" TIMESTAMP(3);
ALTER TABLE "Device" ADD COLUMN "readmittedAt" TIMESTAMP(3);
