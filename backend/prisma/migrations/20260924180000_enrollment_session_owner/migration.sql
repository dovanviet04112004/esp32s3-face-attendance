-- The capture session a door opened and when, so only that door adds to it
-- and only for a while (KEHOACH 7.5).
ALTER TABLE "DeviceEnrollment" ADD COLUMN "sessionAt" TIMESTAMP(3);
ALTER TABLE "DeviceEnrollment" ADD COLUMN "sessionOpenedAt" TIMESTAMP(3);
