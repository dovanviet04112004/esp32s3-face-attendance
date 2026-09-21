-- AlterEnum
ALTER TYPE "NoticeKind" ADD VALUE 'REQUEST_STALLED';

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN "daysWaited" INTEGER;
