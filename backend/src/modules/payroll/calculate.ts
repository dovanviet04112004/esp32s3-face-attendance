import { atLeastZero, atMost, byBasisPoints, mulDiv, type Dong } from "./money.js";

const kMinutesPerHour = 60n;
const kHoursPerDay = 8n;
const kHundred = 100n;
const kNormalRateBp = 10_000;

export type LineKind = "EARNING" | "DEDUCTION" | "EMPLOYER_COST" | "INFO";

export interface CalcLine {
  kind: LineKind;
  code: string;
  label?: string;
  amount: Dong;
  quantity?: number;
  rateBp?: number;
}

export interface CalcBracket {
  upToAmount: Dong | null;
  rateBp: number;
}

export interface CalcPolicy {
  selfDeduction: Dong;
  dependentDeduction: Dong;
  socialRateBp: number;
  healthRateBp: number;
  unemploymentRateBp: number;
  employerSocialRateBp: number;
  employerHealthRateBp: number;
  employerUnemploymentRateBp: number;
  referenceWage: Dong;
  socialCapMultiple: number;
  regionalMinimumWage: Dong;
  unemploymentCapMultiple: number;
  standardDayHundredths: bigint;
  noContributionUnpaidDays: number;
  overtimeWeekdayBp: number;
  overtimeWeekendBp: number;
  overtimeHolidayBp: number;
  nightPremiumBp: number;
  brackets: CalcBracket[];
}

export interface CalcAllowance {
  code: string;
  label: string;
  amount: Dong;
  taxable: boolean;
  insurable: boolean;
  taxFreeCap?: Dong | null; // taxed only above this; null taxes it all
}

export interface CalcExtra {
  code: string;
  label?: string;
  amount: Dong;
  taxable: boolean;
}

export interface CalcDeduction {
  code: string;
  label?: string;
  amount: Dong;
}

export interface CalcOvertime {
  weekdayMinutes: number;
  weekendMinutes: number;
  holidayMinutes: number;
  nightMinutes: number;
}

export interface CalcInput {
  policy: CalcPolicy;
  baseSalary: Dong;
  insuranceSalary: Dong;
  allowances: CalcAllowance[];
  dependentCount: number;
  paidDayHundredths: bigint;
  unpaidDayHundredths: bigint;
  overtime: CalcOvertime;
  extras: CalcExtra[];
  deductions: CalcDeduction[];
}

export interface CalcResult {
  lines: CalcLine[];
  grossPay: Dong;
  taxableIncome: Dong;
  insuranceEmployee: Dong;
  insuranceEmployer: Dong;
  personalIncomeTax: Dong;
  deductionsTotal: Dong;
  netPay: Dong;
}

/** What a reader of a stored payslip matches on, so the name of a component
 *  is written once and read everywhere (CLAUDE.md 4.9).
 */
export const LINE_RELIEF_SELF = "DEDUCT_SELF";
export const LINE_RELIEF_DEPENDENT = "DEDUCT_DEPENDENT";
export const LINE_TAX = "PIT";
export const LINE_EXEMPT_OVERTIME = "OT_EXEMPT";
export const LINE_LEAVE_PAYOUT = "LEAVE_PAYOUT";
export const LINE_SEVERANCE = "SEVERANCE";
export const LINE_ASSET_OFFSET = "ASSET_OFFSET";

interface OvertimeBand {
  code: string;
  minutes: number;
  rateBp: number;
}

function hundredthsToDays(value: bigint): number {
  return Number(value) / 100;
}

/** The hourly rate a month's pay implies, at the policy's standard day count. */
function hourlyRate(baseSalary: Dong, standardDayHundredths: bigint): Dong {
  return mulDiv(baseSalary, kHundred, standardDayHundredths * kHoursPerDay);
}

function overtimeBands(policy: CalcPolicy, overtime: CalcOvertime): OvertimeBand[] {
  return [
    { code: "OT_WEEKDAY", minutes: overtime.weekdayMinutes, rateBp: policy.overtimeWeekdayBp },
    { code: "OT_WEEKEND", minutes: overtime.weekendMinutes, rateBp: policy.overtimeWeekendBp },
    { code: "OT_HOLIDAY", minutes: overtime.holidayMinutes, rateBp: policy.overtimeHolidayBp },
  ].filter((band) => band.minutes > 0);
}

/** Progressive bands, each charged only on the slice that falls inside it. */
export function taxOn(assessable: Dong, brackets: CalcBracket[]): Dong {
  let owed = 0n;
  let floor = 0n;
  for (const bracket of brackets) {
    if (assessable <= floor) {
      break;
    }
    const ceiling = bracket.upToAmount ?? assessable;
    const slice = atMost(assessable, ceiling) - floor;
    if (slice > 0n) {
      owed += byBasisPoints(slice, bracket.rateBp);
    }
    floor = ceiling;
  }
  return owed;
}

export function calculate(input: CalcInput): CalcResult {
  const { policy } = input;
  const lines: CalcLine[] = [];

  const basePay = mulDiv(input.baseSalary, input.paidDayHundredths, policy.standardDayHundredths);
  lines.push({
    kind: "EARNING",
    code: "BASE",
    amount: basePay,
    quantity: hundredthsToDays(input.paidDayHundredths),
  });

  let taxableEarnings = basePay;
  let insurableExtra = 0n;
  for (const allowance of input.allowances) {
    lines.push({
      kind: "EARNING",
      code: `ALW_${allowance.code}`,
      label: allowance.label,
      amount: allowance.amount,
    });
    if (allowance.taxable) {
      taxableEarnings += atLeastZero(allowance.amount - (allowance.taxFreeCap ?? 0n));
    }
    if (allowance.insurable) {
      insurableExtra += allowance.amount;
    }
  }

  // Only the premium above the normal rate is exempt, so the normal part stays
  // in taxable income (Thong tu 111/2013/TT-BTC dieu 3).
  const rate = hourlyRate(input.baseSalary, policy.standardDayHundredths);
  let overtimeExempt = 0n;
  for (const band of overtimeBands(policy, input.overtime)) {
    const minutes = BigInt(band.minutes);
    const paid = mulDiv(rate, minutes * BigInt(band.rateBp), kMinutesPerHour * 10_000n);
    const normal = mulDiv(rate, minutes * BigInt(kNormalRateBp), kMinutesPerHour * 10_000n);
    lines.push({
      kind: "EARNING",
      code: band.code,
      amount: paid,
      quantity: band.minutes,
      rateBp: band.rateBp,
    });
    taxableEarnings += paid;
    overtimeExempt += paid - normal;
  }

  if (input.overtime.nightMinutes > 0) {
    const premium = mulDiv(
      rate,
      BigInt(input.overtime.nightMinutes) * BigInt(policy.nightPremiumBp),
      kMinutesPerHour * 10_000n,
    );
    lines.push({
      kind: "EARNING",
      code: "OT_NIGHT",
      amount: premium,
      quantity: input.overtime.nightMinutes,
      rateBp: policy.nightPremiumBp,
    });
    taxableEarnings += premium;
    overtimeExempt += premium;
  }

  for (const extra of input.extras) {
    lines.push({ kind: "EARNING", code: extra.code, label: extra.label, amount: extra.amount });
    if (extra.taxable) {
      taxableEarnings += extra.amount;
    }
  }

  const grossPay = lines
    .filter((line) => line.kind === "EARNING")
    .reduce((total, line) => total + line.amount, 0n);

  // A month mostly unpaid owes no contribution, which is also what keeps a net
  // figure from going negative when nobody worked (KEHOACH 9.7).
  const exempt =
    input.unpaidDayHundredths >= BigInt(policy.noContributionUnpaidDays) * kHundred;
  const insuranceBase = exempt ? 0n : input.insuranceSalary + insurableExtra;
  const socialCap = policy.referenceWage * BigInt(policy.socialCapMultiple);
  const unemploymentCap = policy.regionalMinimumWage * BigInt(policy.unemploymentCapMultiple);
  const cappedSocial = atMost(insuranceBase, socialCap);
  const cappedUnemployment = atMost(insuranceBase, unemploymentCap);

  const social = byBasisPoints(cappedSocial, policy.socialRateBp);
  const health = byBasisPoints(cappedSocial, policy.healthRateBp);
  const unemployment = byBasisPoints(cappedUnemployment, policy.unemploymentRateBp);
  const insuranceEmployee = social + health + unemployment;
  lines.push({ kind: "DEDUCTION", code: "BHXH", amount: social, rateBp: policy.socialRateBp });
  lines.push({ kind: "DEDUCTION", code: "BHYT", amount: health, rateBp: policy.healthRateBp });
  lines.push({
    kind: "DEDUCTION",
    code: "BHTN",
    amount: unemployment,
    rateBp: policy.unemploymentRateBp,
  });

  const insuranceEmployer =
    byBasisPoints(cappedSocial, policy.employerSocialRateBp) +
    byBasisPoints(cappedSocial, policy.employerHealthRateBp) +
    byBasisPoints(cappedUnemployment, policy.employerUnemploymentRateBp);
  lines.push({ kind: "EMPLOYER_COST", code: "INS_EMPLOYER", amount: insuranceEmployer });

  const taxableIncome = atLeastZero(taxableEarnings - overtimeExempt);
  if (overtimeExempt > 0n) {
    lines.push({ kind: "INFO", code: LINE_EXEMPT_OVERTIME, amount: overtimeExempt });
  }

  const familyDeduction =
    policy.selfDeduction + policy.dependentDeduction * BigInt(input.dependentCount);
  lines.push({ kind: "INFO", code: LINE_RELIEF_SELF, amount: policy.selfDeduction });
  if (input.dependentCount > 0) {
    lines.push({
      kind: "INFO",
      code: LINE_RELIEF_DEPENDENT,
      amount: policy.dependentDeduction * BigInt(input.dependentCount),
      quantity: input.dependentCount,
    });
  }

  const assessable = atLeastZero(taxableIncome - insuranceEmployee - familyDeduction);
  const personalIncomeTax = taxOn(assessable, policy.brackets);
  lines.push({ kind: "DEDUCTION", code: LINE_TAX, amount: personalIncomeTax });

  for (const deduction of input.deductions) {
    lines.push({
      kind: "DEDUCTION",
      code: deduction.code,
      label: deduction.label,
      amount: deduction.amount,
    });
  }

  const deductionsTotal = lines
    .filter((line) => line.kind === "DEDUCTION")
    .reduce((total, line) => total + line.amount, 0n);

  const ordered = lines.map((line, index) => ({ ...line, ordinal: index + 1 }));
  return {
    lines: ordered,
    grossPay,
    taxableIncome,
    insuranceEmployee,
    insuranceEmployer,
    personalIncomeTax,
    deductionsTotal,
    netPay: grossPay - deductionsTotal,
  };
}
