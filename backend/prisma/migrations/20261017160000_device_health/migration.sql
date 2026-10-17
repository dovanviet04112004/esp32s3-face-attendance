-- The last live heartbeat's health numbers, and when they were heard (KEHOACH 4.8).
ALTER TABLE "Device" ADD COLUMN "rssiDbm" INTEGER,
                     ADD COLUMN "heapFreeBytes" INTEGER,
                     ADD COLUMN "heapMinFreeBytes" INTEGER,
                     ADD COLUMN "psramFreeBytes" INTEGER,
                     ADD COLUMN "pendingUplinkCount" INTEGER,
                     ADD COLUMN "activeSlot" INTEGER,
                     ADD COLUMN "bootCount" INTEGER,
                     ADD COLUMN "healthAt" TIMESTAMP(3);

-- When the ticket a kiosk holds was issued and when it dies (KEHOACH 7.3).
ALTER TABLE "Device" ADD COLUMN "tokenIssuedAt" TIMESTAMP(3),
                     ADD COLUMN "tokenExpiresAt" TIMESTAMP(3);

-- A ticket already held dates from the last issue the audit log recorded for its kiosk.
UPDATE "Device" d
   SET "tokenIssuedAt" = a."ts",
       "tokenExpiresAt" = a."ts" + make_interval(days => (a."meta"->>'expiresInDays')::int)
  FROM (SELECT DISTINCT ON ("subjectId") "subjectId", "ts", "meta"
          FROM "AuditLog"
         WHERE "action" = 'device.tokenIssue' AND "subjectType" = 'device'
         ORDER BY "subjectId", "ts" DESC) a
 WHERE d."id" = a."subjectId" AND d."tokenHash" IS NOT NULL;
