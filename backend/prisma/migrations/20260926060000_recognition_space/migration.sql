-- Which recognition model a kiosk runs and a models release carries (KEHOACH 7.5).
ALTER TABLE "Device" ADD COLUMN "embeddingVersion" TEXT;
ALTER TABLE "Release" ADD COLUMN "embeddingVersion" TEXT;
