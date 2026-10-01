-- A notice names what it is about by its subject since 20261001170200_notice_backfill, and nothing has read or
-- written the eight references kept beside it since the release before this one (KEHOACH 9.21.4, 9.22.3c).
-- contract of 20261001170200_notice_backfill
ALTER TABLE "Notification" DROP COLUMN "requestId";
-- contract of 20261001170200_notice_backfill
ALTER TABLE "Notification" DROP COLUMN "advanceId";
-- contract of 20261001170200_notice_backfill
ALTER TABLE "Notification" DROP COLUMN "periodId";
-- contract of 20261001170200_notice_backfill
ALTER TABLE "Notification" DROP COLUMN "payslipId";
-- contract of 20261001170200_notice_backfill
ALTER TABLE "Notification" DROP COLUMN "contractId";
-- contract of 20261001170200_notice_backfill
ALTER TABLE "Notification" DROP COLUMN "certificateId";
-- contract of 20261001170200_notice_backfill
ALTER TABLE "Notification" DROP COLUMN "profileChangeId";
-- contract of 20261001170200_notice_backfill
ALTER TABLE "Notification" DROP COLUMN "dependentId";
