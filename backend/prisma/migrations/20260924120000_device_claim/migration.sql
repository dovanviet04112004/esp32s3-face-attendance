-- A pending kiosk's claim code, kept only as a hash, and the wrong tries
-- against it (KEHOACH 7.3).
ALTER TABLE "Device" ADD COLUMN "claimHash" TEXT;
ALTER TABLE "Device" ADD COLUMN "claimFailures" INTEGER NOT NULL DEFAULT 0;
