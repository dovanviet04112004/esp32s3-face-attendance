-- A decision without its own queue reference opens nowhere in particular (KEHOACH 9.21.4).
ALTER TABLE "Notification" ADD COLUMN "certificateId" TEXT;
ALTER TABLE "Notification" ADD COLUMN "profileChangeId" TEXT;
ALTER TABLE "Notification" ADD COLUMN "dependentId" TEXT;

CREATE INDEX "Notification_kind_contractId_idx" ON "Notification"("kind", "contractId");
