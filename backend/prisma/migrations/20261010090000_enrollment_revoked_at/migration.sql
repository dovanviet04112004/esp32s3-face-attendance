-- When a pair left its door: punches the door took before then still count (KEHOACH 9.8).
ALTER TABLE "DeviceEnrollment" ADD COLUMN "revokedAt" TIMESTAMP(3);

-- updatedAt is the nearest record of when an already revoked pair was revoked.
UPDATE "DeviceEnrollment" SET "revokedAt" = "updatedAt" WHERE "state" = 'REVOKED';
