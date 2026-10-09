-- The kiosk's own count of its events, so a redelivered one is known by key, not by time (KEHOACH 4.6).
-- Null where a kiosk sends none: Postgres keeps NULLs distinct, so those rows never collide.
ALTER TABLE "DeviceEvent" ADD COLUMN "seq" BIGINT;

CREATE UNIQUE INDEX "DeviceEvent_deviceId_seq_key" ON "DeviceEvent"("deviceId", "seq");
