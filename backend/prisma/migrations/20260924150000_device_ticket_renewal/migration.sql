-- The ticket a kiosk held before its last renewal, still accepted until the
-- new one is first used (KEHOACH 7.3).
ALTER TABLE "Device" ADD COLUMN "prevTokenHash" TEXT;
