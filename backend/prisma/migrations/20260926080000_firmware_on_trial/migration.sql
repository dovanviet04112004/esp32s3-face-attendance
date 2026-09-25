-- The heartbeat's onTrial: the firmware a kiosk runs has not confirmed itself yet (KEHOACH 7.7).
-- Null from a build that never sends it, read as confirmed.
ALTER TABLE "Device" ADD COLUMN "fwOnTrial" BOOLEAN;
