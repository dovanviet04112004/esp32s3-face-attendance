-- A release now arrives as a file, so it has a path and may have no url (KEHOACH 7.7).
ALTER TABLE "Release" ALTER COLUMN "url" DROP NOT NULL;
ALTER TABLE "Release" ADD COLUMN "path" TEXT;

-- The newest update offer, read against the heartbeat for its status.
ALTER TABLE "Device" ADD COLUMN "otaReleaseId" UUID;
ALTER TABLE "Device" ADD COLUMN "otaOfferedAt" TIMESTAMP(3);
