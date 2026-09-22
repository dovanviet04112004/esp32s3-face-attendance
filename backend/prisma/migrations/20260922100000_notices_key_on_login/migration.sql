-- A notice is read by whoever logs in, and KEHOACH 9.4 opens logins that have
-- no employee row, so the three notice tables move onto the login. Every row
-- carries over: each one's employee already had exactly one login.

ALTER TABLE "Notification" ADD COLUMN "userId" TEXT;
UPDATE "Notification" n SET "userId" = u."id" FROM "User" u WHERE u."employeeId" = n."employeeId";
DELETE FROM "Notification" WHERE "userId" IS NULL;
-- backfilled by the UPDATE above, and the rows it could not reach are gone.
ALTER TABLE "Notification" ALTER COLUMN "userId" SET NOT NULL;
DROP INDEX IF EXISTS "Notification_employeeId_readAt_idx";
DROP INDEX IF EXISTS "Notification_employeeId_createdAt_idx";
-- replaced by Notification_userId_fkey below.
ALTER TABLE "Notification" DROP CONSTRAINT IF EXISTS "Notification_employeeId_fkey";
-- the contract of Notification.userId answers for this column now.
ALTER TABLE "Notification" DROP COLUMN "employeeId";
CREATE INDEX "Notification_userId_readAt_idx" ON "Notification" ("userId", "readAt");
CREATE INDEX "Notification_userId_createdAt_idx" ON "Notification" ("userId", "createdAt");
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "NotificationPreference" ADD COLUMN "userId" TEXT;
UPDATE "NotificationPreference" p SET "userId" = u."id" FROM "User" u WHERE u."employeeId" = p."employeeId";
DELETE FROM "NotificationPreference" WHERE "userId" IS NULL;
-- backfilled by the UPDATE above, and the rows it could not reach are gone.
ALTER TABLE "NotificationPreference" ALTER COLUMN "userId" SET NOT NULL;
-- replaced by the NotificationPreference_pkey rebuilt on userId below.
ALTER TABLE "NotificationPreference" DROP CONSTRAINT IF EXISTS "NotificationPreference_pkey";
-- replaced by NotificationPreference_userId_fkey below.
ALTER TABLE "NotificationPreference" DROP CONSTRAINT IF EXISTS "NotificationPreference_employeeId_fkey";
-- the contract of NotificationPreference.userId answers for this column now.
ALTER TABLE "NotificationPreference" DROP COLUMN "employeeId";
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_pkey"
  PRIMARY KEY ("userId", "kind", "channel");
ALTER TABLE "NotificationPreference" ADD CONSTRAINT "NotificationPreference_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PushSubscription" ADD COLUMN "userId" TEXT;
UPDATE "PushSubscription" s SET "userId" = u."id" FROM "User" u WHERE u."employeeId" = s."employeeId";
DELETE FROM "PushSubscription" WHERE "userId" IS NULL;
-- backfilled by the UPDATE above, and the rows it could not reach are gone.
ALTER TABLE "PushSubscription" ALTER COLUMN "userId" SET NOT NULL;
DROP INDEX IF EXISTS "PushSubscription_employeeId_idx";
-- replaced by PushSubscription_userId_fkey below.
ALTER TABLE "PushSubscription" DROP CONSTRAINT IF EXISTS "PushSubscription_employeeId_fkey";
-- the contract of PushSubscription.userId answers for this column now.
ALTER TABLE "PushSubscription" DROP COLUMN "employeeId";
CREATE INDEX "PushSubscription_userId_idx" ON "PushSubscription" ("userId");
ALTER TABLE "PushSubscription" ADD CONSTRAINT "PushSubscription_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
