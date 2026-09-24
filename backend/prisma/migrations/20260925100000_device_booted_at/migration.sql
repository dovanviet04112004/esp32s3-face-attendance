-- When the kiosk last booted, from its heartbeat, so an update cut by a reboot shows (KEHOACH 7.7).
ALTER TABLE "Device" ADD COLUMN "bootedAt" TIMESTAMP(3);
