-- CreateEnum
CREATE TYPE "ProfileField" AS ENUM ('PERSONAL_EMAIL', 'PHONE', 'BANK', 'NATIONAL_ID', 'TAX_CODE', 'SOCIAL_INSURANCE_NO');

-- CreateEnum
CREATE TYPE "ProfileChangeState" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED');

-- AlterTable
ALTER TABLE "Payslip" ADD COLUMN     "bankAccount" TEXT,
ADD COLUMN     "bankName" TEXT;

-- The payment file reads this copy, so a period locked before this migration
-- keeps the destination it had rather than reading a later change.
UPDATE "Payslip" p
   SET "bankName" = e."bankName", "bankAccount" = e."bankAccount"
  FROM "Employee" e, "PayrollPeriod" k
 WHERE p."employeeId" = e."id"
   AND p."periodId" = k."id"
   AND k."state" <> 'OPEN';

-- CreateTable
CREATE TABLE "ProfileChange" (
    "id" TEXT NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "field" "ProfileField" NOT NULL,
    "oldValue" JSONB,
    "newValue" JSONB NOT NULL,
    "state" "ProfileChangeState" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "noticeTo" TEXT,
    "noticeSentAt" TIMESTAMP(3),
    "askedById" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProfileChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProfileChange_state_createdAt_idx" ON "ProfileChange"("state", "createdAt");

-- CreateIndex
CREATE INDEX "ProfileChange_employeeId_createdAt_idx" ON "ProfileChange"("employeeId", "createdAt");

-- AddForeignKey
ALTER TABLE "ProfileChange" ADD CONSTRAINT "ProfileChange_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfileChange" ADD CONSTRAINT "ProfileChange_askedById_fkey" FOREIGN KEY ("askedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfileChange" ADD CONSTRAINT "ProfileChange_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
