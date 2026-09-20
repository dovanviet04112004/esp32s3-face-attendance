-- CreateEnum
CREATE TYPE "PayReason" AS ENUM ('HIRE', 'PROMOTION', 'ANNUAL_REVIEW', 'ADJUSTMENT', 'TRANSFER', 'OTHER');

-- CreateEnum
CREATE TYPE "DependentRelation" AS ENUM ('CHILD', 'SPOUSE', 'PARENT', 'SIBLING', 'OTHER');

-- CreateEnum
CREATE TYPE "DependentState" AS ENUM ('PENDING', 'ACTIVE', 'REJECTED', 'ENDED');

-- CreateEnum
CREATE TYPE "PeriodState" AS ENUM ('OPEN', 'LOCKED', 'PAID');

-- CreateEnum
CREATE TYPE "RunKind" AS ENUM ('REGULAR', 'BONUS', 'FINAL_SETTLEMENT');

-- CreateEnum
CREATE TYPE "RunState" AS ENUM ('DRAFT', 'RUNNING', 'DONE', 'FAILED', 'DISCARDED');

-- CreateEnum
CREATE TYPE "PayslipState" AS ENUM ('DRAFT', 'ISSUED', 'SENT', 'VIEWED');

-- CreateEnum
CREATE TYPE "LineKind" AS ENUM ('EARNING', 'DEDUCTION', 'EMPLOYER_COST', 'INFO');

-- CreateEnum
CREATE TYPE "RetroState" AS ENUM ('PENDING', 'APPLIED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AdvanceState" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'PAID', 'SETTLED', 'CANCELLED');

-- CreateTable
CREATE TABLE "CompensationRecord" (
    "id" TEXT NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "effectiveFrom" DATE NOT NULL,
    "baseSalary" DECIMAL(14,0) NOT NULL,
    "insuranceSalary" DECIMAL(14,0) NOT NULL,
    "reason" "PayReason" NOT NULL DEFAULT 'ADJUSTMENT',
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompensationRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompensationAllowance" (
    "id" TEXT NOT NULL,
    "recordId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "amount" DECIMAL(14,0) NOT NULL,
    "taxable" BOOLEAN NOT NULL DEFAULT true,
    "insurable" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "CompensationAllowance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Dependent" (
    "id" TEXT NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "fullName" TEXT NOT NULL,
    "relation" "DependentRelation" NOT NULL,
    "dateOfBirth" DATE,
    "taxCode" TEXT,
    "nationalId" TEXT,
    "fromMonth" DATE NOT NULL,
    "toMonth" DATE,
    "state" "DependentState" NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Dependent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollPolicy" (
    "id" TEXT NOT NULL,
    "legalEntityId" TEXT,
    "effectiveFrom" DATE NOT NULL,
    "selfDeduction" DECIMAL(14,0) NOT NULL,
    "dependentDeduction" DECIMAL(14,0) NOT NULL,
    "socialRateBp" INTEGER NOT NULL,
    "healthRateBp" INTEGER NOT NULL,
    "unemploymentRateBp" INTEGER NOT NULL,
    "employerSocialRateBp" INTEGER NOT NULL,
    "employerHealthRateBp" INTEGER NOT NULL,
    "employerUnemploymentRateBp" INTEGER NOT NULL,
    "referenceWage" DECIMAL(14,0) NOT NULL,
    "socialCapMultiple" INTEGER NOT NULL DEFAULT 20,
    "regionalMinimumWage" DECIMAL(14,0) NOT NULL,
    "unemploymentCapMultiple" INTEGER NOT NULL DEFAULT 20,
    "standardDaysPerMonth" DECIMAL(5,2) NOT NULL,
    "overtimeWeekdayBp" INTEGER NOT NULL DEFAULT 15000,
    "overtimeWeekendBp" INTEGER NOT NULL DEFAULT 20000,
    "overtimeHolidayBp" INTEGER NOT NULL DEFAULT 30000,
    "nightPremiumBp" INTEGER NOT NULL DEFAULT 3000,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxBracket" (
    "id" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "upToAmount" DECIMAL(14,0),
    "rateBp" INTEGER NOT NULL,

    CONSTRAINT "TaxBracket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollPeriod" (
    "id" TEXT NOT NULL,
    "legalEntityId" TEXT,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "state" "PeriodState" NOT NULL DEFAULT 'OPEN',
    "startDate" DATE NOT NULL,
    "endDate" DATE NOT NULL,
    "payDate" DATE,
    "lockedAt" TIMESTAMP(3),
    "lockedById" TEXT,
    "lockNote" TEXT,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PayrollPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayrollRun" (
    "id" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "kind" "RunKind" NOT NULL DEFAULT 'REGULAR',
    "state" "RunState" NOT NULL DEFAULT 'DRAFT',
    "label" TEXT,
    "departmentId" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "employeeCount" INTEGER NOT NULL DEFAULT 0,
    "doneCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "grossTotal" DECIMAL(16,0) NOT NULL DEFAULT 0,
    "netTotal" DECIMAL(16,0) NOT NULL DEFAULT 0,
    "createdById" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PayrollRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payslip" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "periodId" TEXT NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "policyId" TEXT NOT NULL,
    "state" "PayslipState" NOT NULL DEFAULT 'DRAFT',
    "workedDays" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "paidLeaveDays" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "unpaidDays" DECIMAL(6,2) NOT NULL DEFAULT 0,
    "workedMinutes" INTEGER NOT NULL DEFAULT 0,
    "overtimeMinutes" INTEGER NOT NULL DEFAULT 0,
    "grossPay" DECIMAL(14,0) NOT NULL DEFAULT 0,
    "taxableIncome" DECIMAL(14,0) NOT NULL DEFAULT 0,
    "insuranceEmployee" DECIMAL(14,0) NOT NULL DEFAULT 0,
    "insuranceEmployer" DECIMAL(14,0) NOT NULL DEFAULT 0,
    "personalIncomeTax" DECIMAL(14,0) NOT NULL DEFAULT 0,
    "deductionsTotal" DECIMAL(14,0) NOT NULL DEFAULT 0,
    "netPay" DECIMAL(14,0) NOT NULL DEFAULT 0,
    "issuedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "viewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payslip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PayslipLine" (
    "id" TEXT NOT NULL,
    "payslipId" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "kind" "LineKind" NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT,
    "amount" DECIMAL(14,0) NOT NULL,
    "quantity" DECIMAL(10,2),
    "rateBp" INTEGER,

    CONSTRAINT "PayslipLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RetroAdjustment" (
    "id" TEXT NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "sourcePeriodId" TEXT NOT NULL,
    "appliedPeriodId" TEXT,
    "code" TEXT NOT NULL,
    "label" TEXT,
    "amount" DECIMAL(14,0) NOT NULL,
    "state" "RetroState" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RetroAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SalaryAdvance" (
    "id" TEXT NOT NULL,
    "employeeId" INTEGER NOT NULL,
    "amount" DECIMAL(14,0) NOT NULL,
    "reason" TEXT NOT NULL,
    "state" "AdvanceState" NOT NULL DEFAULT 'PENDING',
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approverId" INTEGER,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "paidAt" TIMESTAMP(3),
    "settledAt" TIMESTAMP(3),
    "payslipId" TEXT,

    CONSTRAINT "SalaryAdvance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CompensationRecord_employeeId_effectiveFrom_idx" ON "CompensationRecord"("employeeId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "CompensationRecord_employeeId_effectiveFrom_key" ON "CompensationRecord"("employeeId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "CompensationAllowance_code_idx" ON "CompensationAllowance"("code");

-- CreateIndex
CREATE UNIQUE INDEX "CompensationAllowance_recordId_code_key" ON "CompensationAllowance"("recordId", "code");

-- CreateIndex
CREATE INDEX "Dependent_employeeId_state_idx" ON "Dependent"("employeeId", "state");

-- CreateIndex
CREATE INDEX "Dependent_state_fromMonth_idx" ON "Dependent"("state", "fromMonth");

-- CreateIndex
CREATE INDEX "PayrollPolicy_effectiveFrom_idx" ON "PayrollPolicy"("effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollPolicy_legalEntityId_effectiveFrom_key" ON "PayrollPolicy"("legalEntityId", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "TaxBracket_policyId_ordinal_key" ON "TaxBracket"("policyId", "ordinal");

-- CreateIndex
CREATE INDEX "PayrollPeriod_state_year_month_idx" ON "PayrollPeriod"("state", "year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "PayrollPeriod_legalEntityId_year_month_key" ON "PayrollPeriod"("legalEntityId", "year", "month");

-- CreateIndex
CREATE INDEX "PayrollRun_periodId_state_idx" ON "PayrollRun"("periodId", "state");

-- CreateIndex
CREATE INDEX "Payslip_employeeId_periodId_idx" ON "Payslip"("employeeId", "periodId");

-- CreateIndex
CREATE INDEX "Payslip_periodId_state_idx" ON "Payslip"("periodId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "Payslip_runId_employeeId_key" ON "Payslip"("runId", "employeeId");

-- CreateIndex
CREATE INDEX "PayslipLine_code_idx" ON "PayslipLine"("code");

-- CreateIndex
CREATE UNIQUE INDEX "PayslipLine_payslipId_code_key" ON "PayslipLine"("payslipId", "code");

-- CreateIndex
CREATE INDEX "RetroAdjustment_employeeId_state_idx" ON "RetroAdjustment"("employeeId", "state");

-- CreateIndex
CREATE INDEX "RetroAdjustment_state_sourcePeriodId_idx" ON "RetroAdjustment"("state", "sourcePeriodId");

-- CreateIndex
CREATE INDEX "SalaryAdvance_employeeId_state_idx" ON "SalaryAdvance"("employeeId", "state");

-- CreateIndex
CREATE INDEX "SalaryAdvance_state_requestedAt_idx" ON "SalaryAdvance"("state", "requestedAt");

-- AddForeignKey
ALTER TABLE "CompensationRecord" ADD CONSTRAINT "CompensationRecord_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompensationAllowance" ADD CONSTRAINT "CompensationAllowance_recordId_fkey" FOREIGN KEY ("recordId") REFERENCES "CompensationRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Dependent" ADD CONSTRAINT "Dependent_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollPolicy" ADD CONSTRAINT "PayrollPolicy_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "LegalEntity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxBracket" ADD CONSTRAINT "TaxBracket_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "PayrollPolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollPeriod" ADD CONSTRAINT "PayrollPeriod_legalEntityId_fkey" FOREIGN KEY ("legalEntityId") REFERENCES "LegalEntity"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayrollRun" ADD CONSTRAINT "PayrollRun_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "PayrollPeriod"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payslip" ADD CONSTRAINT "Payslip_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PayrollRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payslip" ADD CONSTRAINT "Payslip_periodId_fkey" FOREIGN KEY ("periodId") REFERENCES "PayrollPeriod"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payslip" ADD CONSTRAINT "Payslip_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payslip" ADD CONSTRAINT "Payslip_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "PayrollPolicy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PayslipLine" ADD CONSTRAINT "PayslipLine_payslipId_fkey" FOREIGN KEY ("payslipId") REFERENCES "Payslip"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RetroAdjustment" ADD CONSTRAINT "RetroAdjustment_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RetroAdjustment" ADD CONSTRAINT "RetroAdjustment_sourcePeriodId_fkey" FOREIGN KEY ("sourcePeriodId") REFERENCES "PayrollPeriod"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RetroAdjustment" ADD CONSTRAINT "RetroAdjustment_appliedPeriodId_fkey" FOREIGN KEY ("appliedPeriodId") REFERENCES "PayrollPeriod"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalaryAdvance" ADD CONSTRAINT "SalaryAdvance_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "Employee"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SalaryAdvance" ADD CONSTRAINT "SalaryAdvance_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "Employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

