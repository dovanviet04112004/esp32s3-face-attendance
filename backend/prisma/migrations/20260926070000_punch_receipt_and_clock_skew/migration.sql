-- When the server heard each punch, and whether its own time is past believing (KEHOACH 9.8).
ALTER TABLE "AttendanceRecord" ADD COLUMN "receivedAt" TIMESTAMP(3);
ALTER TABLE "AttendanceRecord" ADD COLUMN "questionableTime" BOOLEAN NOT NULL DEFAULT false;

-- A row is written the moment its message is heard, so its createdAt is its receipt.
UPDATE "AttendanceRecord"
   SET "receivedAt" = "createdAt",
       "questionableTime" = ("ts" < TIMESTAMP '2020-01-01' OR "ts" > "createdAt" + INTERVAL '1 day');

-- Today's exceptions and a person's flag filter find these by arrival, and they are few.
CREATE INDEX "AttendanceRecord_questionable_receivedAt_idx"
    ON "AttendanceRecord" ("employeeId", "receivedAt")
 WHERE "questionableTime";

-- The kiosk's clock less the server's, from its last live heartbeat (KEHOACH 9.8).
ALTER TABLE "Device" ADD COLUMN "clockSkewMs" DOUBLE PRECISION;
