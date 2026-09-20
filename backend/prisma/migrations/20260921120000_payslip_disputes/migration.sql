-- CreateEnum
CREATE TYPE "DisputeState" AS ENUM ('OPEN', 'ANSWERED', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "DisputeOutcome" AS ENUM ('UPHELD', 'REJECTED');

-- CreateTable
CREATE TABLE "PayslipDispute" (
    "id" TEXT NOT NULL,
    "payslipId" TEXT NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "lineCode" TEXT,
    "claim" TEXT NOT NULL,
    "state" "DisputeState" NOT NULL DEFAULT 'OPEN',
    "dueAt" TIMESTAMP(3) NOT NULL,
    "outcome" "DisputeOutcome",
    "answer" TEXT,
    "answeredAt" TIMESTAMP(3),
    "answeredById" TEXT,
    "retroId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayslipDispute_pkey" PRIMARY KEY ("id")
);

-- One adjustment answers one dispute, so a second one cannot quietly point at
-- money already paid out for the first (KEHOACH 9.17 item 11).
CREATE UNIQUE INDEX "PayslipDispute_retroId_key" ON "PayslipDispute"("retroId");

-- CreateIndex
CREATE INDEX "PayslipDispute_state_dueAt_idx" ON "PayslipDispute"("state", "dueAt");

-- CreateIndex
CREATE INDEX "PayslipDispute_employeeId_createdAt_idx" ON "PayslipDispute"("employeeId", "createdAt");

-- CreateIndex
CREATE INDEX "PayslipDispute_payslipId_state_idx" ON "PayslipDispute"("payslipId", "state");

-- AddForeignKey
ALTER TABLE "PayslipDispute" ADD CONSTRAINT "PayslipDispute_payslipId_fkey" FOREIGN KEY ("payslipId") REFERENCES "Payslip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayslipDispute" ADD CONSTRAINT "PayslipDispute_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayslipDispute" ADD CONSTRAINT "PayslipDispute_answeredById_fkey" FOREIGN KEY ("answeredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayslipDispute" ADD CONSTRAINT "PayslipDispute_retroId_fkey" FOREIGN KEY ("retroId") REFERENCES "RetroAdjustment"("id") ON DELETE SET NULL ON UPDATE CASCADE;
