import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { calculate, taxOn, type CalcInput, type CalcPolicy } from "../src/modules/payroll/calculate.js";

const POLICY: CalcPolicy = {
  selfDeduction: 15_500_000n,
  dependentDeduction: 6_200_000n,
  socialRateBp: 800,
  healthRateBp: 150,
  unemploymentRateBp: 100,
  employerSocialRateBp: 1750,
  employerHealthRateBp: 300,
  employerUnemploymentRateBp: 100,
  referenceWage: 2_340_000n,
  socialCapMultiple: 20,
  regionalMinimumWage: 5_310_000n,
  unemploymentCapMultiple: 20,
  standardDayHundredths: 2600n,
  noContributionUnpaidDays: 14,
  overtimeWeekdayBp: 15_000,
  overtimeWeekendBp: 20_000,
  overtimeHolidayBp: 30_000,
  nightPremiumBp: 3_000,
  brackets: [
    { upToAmount: 10_000_000n, rateBp: 500 },
    { upToAmount: 30_000_000n, rateBp: 1000 },
    { upToAmount: 60_000_000n, rateBp: 2000 },
    { upToAmount: 100_000_000n, rateBp: 3000 },
    { upToAmount: null, rateBp: 3500 },
  ],
};

// What the tax office publishes beside the table: rate times income, less a
// constant per band. Another road to the same figure (KEHOACH 9.7).
const SHORTCUT: { upTo: bigint | null; rateBp: number; less: bigint }[] = [
  { upTo: 10_000_000n, rateBp: 500, less: 0n },
  { upTo: 30_000_000n, rateBp: 1000, less: 500_000n },
  { upTo: 60_000_000n, rateBp: 2000, less: 3_500_000n },
  { upTo: 100_000_000n, rateBp: 3000, less: 9_500_000n },
  { upTo: null, rateBp: 3500, less: 14_500_000n },
];

function byShortcut(assessable: bigint): bigint {
  const band = SHORTCUT.find((one) => one.upTo === null || assessable <= one.upTo);
  if (!band) {
    return 0n;
  }
  // Half up, the same convention a payslip reader expects; the point of this
  // helper is the table, not the rounding.
  const scaled = assessable * BigInt(band.rateBp) + 5_000n;
  return scaled / 10_000n - band.less;
}

function input(over: Partial<CalcInput> = {}): CalcInput {
  return {
    policy: POLICY,
    baseSalary: 20_000_000n,
    insuranceSalary: 20_000_000n,
    allowances: [],
    dependentCount: 0,
    paidDayHundredths: 2600n,
    unpaidDayHundredths: 0n,
    overtime: { weekdayMinutes: 0, weekendMinutes: 0, holidayMinutes: 0, nightMinutes: 0 },
    extras: [],
    deductions: [],
    ...over,
  };
}

function amountOf(result: ReturnType<typeof calculate>, code: string): bigint {
  return result.lines.find((line) => line.code === code)?.amount ?? 0n;
}

describe("payroll calculation", () => {
  it("charges each progressive band only on its own slice", () => {
    // 20,000,000: 10,000,000 at 5% plus 10,000,000 at 10%.
    assert.equal(taxOn(20_000_000n, POLICY.brackets), 1_500_000n);
    assert.equal(taxOn(0n, POLICY.brackets), 0n);
    assert.equal(taxOn(10_000_000n, POLICY.brackets), 500_000n);
    // 150,000,000 walks every band including the open-ended one.
    assert.equal(
      taxOn(150_000_000n, POLICY.brackets),
      500_000n + 2_000_000n + 6_000_000n + 12_000_000n + 17_500_000n,
    );
  });

  it("joins at every boundary, which a wrong rate would break", () => {
    for (const edge of [10_000_000n, 30_000_000n, 60_000_000n, 100_000_000n]) {
      const below = taxOn(edge, POLICY.brackets);
      const above = taxOn(edge + 1n, POLICY.brackets);
      const step = POLICY.brackets.find((one) => one.upToAmount === null || one.upToAmount > edge);
      assert.equal(above - below, (BigInt(step?.rateBp ?? 0) * 1n) / 10_000n);
    }
  });

  it("agrees with the shortcut formula the tax office publishes", () => {
    const probes = [
      1n,
      9_999_999n,
      10_000_000n,
      10_000_001n,
      29_999_999n,
      30_000_000n,
      45_000_000n,
      60_000_000n,
      99_999_999n,
      100_000_000n,
      115_309_077n,
      500_000_000n,
    ];
    for (const probe of probes) {
      assert.equal(taxOn(probe, POLICY.brackets), byShortcut(probe), `at ${probe}`);
    }
  });

  it("works a full month with no dependants", () => {
    const result = calculate(input());
    assert.equal(result.grossPay, 20_000_000n);
    assert.equal(amountOf(result, "BHXH"), 1_600_000n);
    assert.equal(amountOf(result, "BHYT"), 300_000n);
    assert.equal(amountOf(result, "BHTN"), 200_000n);
    assert.equal(result.insuranceEmployee, 2_100_000n);
    // 20,000,000 - 2,100,000 - 15,500,000 = 2,400,000 assessable at 5%.
    assert.equal(result.personalIncomeTax, 120_000n);
    assert.equal(result.netPay, 20_000_000n - 2_100_000n - 120_000n);
  });

  it("drops the tax to zero once two dependants are registered", () => {
    const result = calculate(input({ dependentCount: 2 }));
    assert.equal(result.personalIncomeTax, 0n);
    assert.equal(result.netPay, 17_900_000n);
  });

  it("stops the contribution base at twenty times the reference wage", () => {
    const result = calculate(input({ baseSalary: 100_000_000n, insuranceSalary: 100_000_000n }));
    // Capped at 46,800,000 rather than charged on the whole 100,000,000.
    assert.equal(amountOf(result, "BHXH"), 3_744_000n);
    assert.equal(amountOf(result, "BHYT"), 702_000n);
    // Unemployment has its own, higher ceiling of 106,200,000, so it is uncapped here.
    assert.equal(amountOf(result, "BHTN"), 1_000_000n);
  });

  it("pays a half month for half the days", () => {
    const result = calculate(input({ paidDayHundredths: 1300n, unpaidDayHundredths: 1300n }));
    assert.equal(amountOf(result, "BASE"), 10_000_000n);
    // Thirteen unpaid days is one short of the threshold, so contributions hold.
    assert.equal(result.insuranceEmployee, 2_100_000n);
  });

  it("charges nothing for a month with no pay, rather than a negative net", () => {
    const result = calculate(input({ paidDayHundredths: 0n, unpaidDayHundredths: 2600n }));
    assert.equal(result.grossPay, 0n);
    assert.equal(result.insuranceEmployee, 0n);
    assert.equal(result.insuranceEmployer, 0n);
    assert.equal(result.personalIncomeTax, 0n);
    assert.equal(result.netPay, 0n);
  });

  it("stops contributions at exactly fourteen unpaid days", () => {
    const under = calculate(input({ paidDayHundredths: 1300n, unpaidDayHundredths: 1300n }));
    const over = calculate(input({ paidDayHundredths: 1200n, unpaidDayHundredths: 1400n }));
    assert.equal(under.insuranceEmployee, 2_100_000n);
    assert.equal(over.insuranceEmployee, 0n);
    assert.ok(over.netPay > 0n);
  });

  it("taxes the normal part of overtime and exempts the premium", () => {
    // Eight hours at 150%: hourly rate is 20,000,000 / (26 * 8) = 96,154.
    const result = calculate(
      input({ overtime: { weekdayMinutes: 480, weekendMinutes: 0, holidayMinutes: 0, nightMinutes: 0 } }),
    );
    assert.equal(amountOf(result, "OT_WEEKDAY"), 1_153_848n);
    assert.equal(amountOf(result, "OT_EXEMPT"), 384_616n);
    assert.equal(result.grossPay, 21_153_848n);
    assert.equal(result.taxableIncome, 20_769_232n);
  });

  it("keeps an untaxed allowance out of taxable income but inside gross", () => {
    const result = calculate(
      input({
        allowances: [
          { code: "LUNCH", label: "Tien an", amount: 730_000n, taxable: false, insurable: false },
          { code: "FUEL", label: "Xang xe", amount: 500_000n, taxable: true, insurable: false },
        ],
      }),
    );
    assert.equal(result.grossPay, 21_230_000n);
    assert.equal(result.taxableIncome, 20_500_000n);
  });

  it("taxes a capped allowance only above its cap, and pays all of it", () => {
    const plain = calculate(input());
    const capped = calculate(
      input({
        allowances: [
          { code: "LUNCH", label: "Tien an", amount: 1_000_000n, taxable: true, insurable: false, taxFreeCap: 730_000n },
          { code: "PHONE", label: "Dien thoai", amount: 500_000n, taxable: true, insurable: true, taxFreeCap: 800_000n },
        ],
      }),
    );
    assert.equal(capped.grossPay, plain.grossPay + 1_500_000n);
    // 270,000 above the lunch cap is taxed; the phone allowance sits under its cap.
    assert.equal(capped.taxableIncome, plain.taxableIncome + 270_000n);
    // A cap on tax leaves the insurance base alone: the phone allowance is still insured.
    assert.equal(amountOf(capped, "BHXH"), amountOf(plain, "BHXH") + 40_000n);
  });

  it("subtracts an advance after tax, not before it", () => {
    const plain = calculate(input());
    const owing = calculate(input({ deductions: [{ code: "ADVANCE", amount: 3_000_000n }] }));
    assert.equal(owing.personalIncomeTax, plain.personalIncomeTax);
    assert.equal(owing.netPay, plain.netPay - 3_000_000n);
  });

  it("balances: gross less every deduction is what lands in the account", () => {
    const result = calculate(
      input({
        dependentCount: 1,
        allowances: [{ code: "PHONE", label: "Dien thoai", amount: 300_000n, taxable: true, insurable: true }],
        overtime: { weekdayMinutes: 120, weekendMinutes: 60, holidayMinutes: 0, nightMinutes: 30 },
        extras: [{ code: "BONUS", amount: 5_000_000n, taxable: true }],
        deductions: [{ code: "UNION", amount: 100_000n }],
      }),
    );
    const earnings = result.lines
      .filter((line) => line.kind === "EARNING")
      .reduce((total, line) => total + line.amount, 0n);
    const taken = result.lines
      .filter((line) => line.kind === "DEDUCTION")
      .reduce((total, line) => total + line.amount, 0n);
    assert.equal(result.grossPay, earnings);
    assert.equal(result.deductionsTotal, taken);
    assert.equal(result.netPay, earnings - taken);
    // The employer's own contributions never move the net figure.
    assert.ok(result.insuranceEmployer > 0n);
  });
});
