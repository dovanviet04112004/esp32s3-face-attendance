-- CreateTable
CREATE TABLE "BonusItem" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT,
    "amount" DECIMAL(14,0) NOT NULL,
    "taxable" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BonusItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BonusItem_employeeId_idx" ON "BonusItem"("employeeId");

-- CreateIndex
CREATE UNIQUE INDEX "BonusItem_runId_employeeId_code_key" ON "BonusItem"("runId", "employeeId", "code");

-- AddForeignKey
ALTER TABLE "BonusItem" ADD CONSTRAINT "BonusItem_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PayrollRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BonusItem" ADD CONSTRAINT "BonusItem_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

