-- Created only once 20261001170200_notice_backfill has given every row a key and folded the repeats.
CREATE UNIQUE INDEX "Notification_userId_dedupKey_key" ON "Notification"("userId", "dedupKey");

-- The bell's number, the read this part runs most (KEHOACH 9.21.4); Prisma cannot declare a partial index.
CREATE INDEX "Notification_userId_unread_idx" ON "Notification"("userId")
  WHERE "readAt" IS NULL AND "archivedAt" IS NULL AND "leftAt" IS NULL;
