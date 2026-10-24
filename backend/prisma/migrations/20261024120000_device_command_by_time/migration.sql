-- A kiosk's command list pages on (createdAt, cmdId), so the index covers that exact pair (KEHOACH 9.9 rule 3).
CREATE INDEX "DeviceCommand_deviceId_createdAt_cmdId_idx" ON "DeviceCommand"("deviceId", "createdAt", "cmdId");
