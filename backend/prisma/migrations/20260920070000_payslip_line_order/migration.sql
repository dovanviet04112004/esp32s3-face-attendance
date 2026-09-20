-- DropIndex
DROP INDEX "PayslipLine_payslipId_code_key";

-- CreateIndex
CREATE UNIQUE INDEX "PayslipLine_payslipId_ordinal_key" ON "PayslipLine"("payslipId", "ordinal");

