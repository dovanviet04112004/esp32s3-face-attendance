-- CreateEnum
CREATE TYPE "SettlementKind" AS ENUM ('SEVERANCE', 'ASSET_OFFSET');

-- CreateTable
CREATE TABLE "SettlementItem" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "kind" "SettlementKind" NOT NULL,
    "label" TEXT,
    "amount" DECIMAL(14,0) NOT NULL,
    "taxable" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SettlementItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SettlementItem_runId_employeeId_idx" ON "SettlementItem"("runId", "employeeId");

-- CreateIndex
CREATE INDEX "SettlementItem_employeeId_idx" ON "SettlementItem"("employeeId");

-- AddForeignKey
ALTER TABLE "SettlementItem" ADD CONSTRAINT "SettlementItem_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PayrollRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SettlementItem" ADD CONSTRAINT "SettlementItem_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- An amount that cannot be negative is refused by the database, not by
-- whichever service remembered: the sign is carried by kind, not by the figure
-- (KEHOACH 9.22.4).
ALTER TABLE "SettlementItem"
    ADD CONSTRAINT "SettlementItem_amount_not_negative" CHECK ("amount" >= 0);
