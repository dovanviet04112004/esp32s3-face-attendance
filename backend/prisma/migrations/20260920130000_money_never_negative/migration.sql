-- An amount that cannot be negative should be refused by the database, not by
-- whichever service happened to remember (KEHOACH 9.22.4). Every one of these
-- passed against live data before being added.

ALTER TABLE "Payslip"
    ADD CONSTRAINT "Payslip_amounts_not_negative" CHECK (
        "grossPay" >= 0 AND "taxableIncome" >= 0
        AND "insuranceEmployee" >= 0 AND "insuranceEmployer" >= 0
        AND "personalIncomeTax" >= 0 AND "deductionsTotal" >= 0
        AND "workedDays" >= 0 AND "paidLeaveDays" >= 0 AND "unpaidDays" >= 0
        AND "workedMinutes" >= 0 AND "overtimeMinutes" >= 0
    );

-- netPay is deliberately absent above and constrained here instead: it is the
-- only figure a large recovered advance can legitimately push below zero, and
-- the bound that matters is that it never exceeds what was earned.
ALTER TABLE "Payslip"
    ADD CONSTRAINT "Payslip_net_within_gross" CHECK ("netPay" <= "grossPay");

ALTER TABLE "PayslipLine"
    ADD CONSTRAINT "PayslipLine_amount_not_negative" CHECK ("amount" >= 0);

ALTER TABLE "CompensationRecord"
    ADD CONSTRAINT "CompensationRecord_pay_not_negative"
    CHECK ("baseSalary" >= 0 AND "insuranceSalary" >= 0);

ALTER TABLE "CompensationAllowance"
    ADD CONSTRAINT "CompensationAllowance_amount_not_negative" CHECK ("amount" >= 0);

ALTER TABLE "BonusItem"
    ADD CONSTRAINT "BonusItem_amount_not_negative" CHECK ("amount" >= 0);

ALTER TABLE "SalaryAdvance"
    ADD CONSTRAINT "SalaryAdvance_amount_positive" CHECK ("amount" > 0);

ALTER TABLE "AttendanceDay"
    ADD CONSTRAINT "AttendanceDay_minutes_not_negative" CHECK (
        "workedMinutes" >= 0 AND "lateMinutes" >= 0
        AND "earlyLeaveMinutes" >= 0 AND "overtimeMinutes" >= 0 AND "punchCount" >= 0
    );

ALTER TABLE "LeaveBalance"
    ADD CONSTRAINT "LeaveBalance_days_not_negative" CHECK (
        "entitled" >= 0 AND "carriedOver" >= 0 AND "taken" >= 0 AND "pending" >= 0
    );

ALTER TABLE "Request"
    ADD CONSTRAINT "Request_range_forwards" CHECK ("toDate" >= "fromDate"),
    ADD CONSTRAINT "Request_amounts_not_negative" CHECK ("days" >= 0 AND "minutes" >= 0);

ALTER TABLE "PayrollPeriod"
    ADD CONSTRAINT "PayrollPeriod_range_forwards" CHECK ("endDate" >= "startDate"),
    ADD CONSTRAINT "PayrollPeriod_month_real" CHECK ("month" BETWEEN 1 AND 12);

ALTER TABLE "EmploymentContract"
    ADD CONSTRAINT "EmploymentContract_range_forwards"
    CHECK ("endDate" IS NULL OR "endDate" >= "startDate");

-- A rate above 100 per cent is a typo, and a tax table is the worst place for
-- one to survive.
ALTER TABLE "TaxBracket"
    ADD CONSTRAINT "TaxBracket_rate_is_a_rate" CHECK ("rateBp" BETWEEN 0 AND 10000);

ALTER TABLE "PayrollPolicy"
    ADD CONSTRAINT "PayrollPolicy_rates_are_rates" CHECK (
        "socialRateBp" BETWEEN 0 AND 10000 AND "healthRateBp" BETWEEN 0 AND 10000
        AND "unemploymentRateBp" BETWEEN 0 AND 10000
        AND "employerSocialRateBp" BETWEEN 0 AND 10000
        AND "employerHealthRateBp" BETWEEN 0 AND 10000
        AND "employerUnemploymentRateBp" BETWEEN 0 AND 10000
    ),
    ADD CONSTRAINT "PayrollPolicy_deductions_not_negative" CHECK (
        "selfDeduction" >= 0 AND "dependentDeduction" >= 0
        AND "referenceWage" >= 0 AND "regionalMinimumWage" >= 0
        AND "standardDaysPerMonth" > 0
    );
