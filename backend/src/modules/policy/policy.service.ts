import { Injectable, NotFoundException } from "@nestjs/common";
import type { PayrollPolicy, TaxBracket } from "@prisma/client";

import { PrismaService } from "../../database/prisma.service.js";
import { AuditService } from "../audit/audit.service.js";
import type { CalcPolicy } from "../payroll/calculate.js";
import { toDong, toHundredths } from "../payroll/money.js";
import type { CreatePolicyDto } from "./dto/policy.dto.js";

export type PolicyWithBrackets = PayrollPolicy & { brackets: TaxBracket[] };

@Injectable()
export class PolicyService {
  constructor(
    private readonly db: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(legalEntityId?: string): Promise<PolicyWithBrackets[]> {
    return this.db.payrollPolicy.findMany({
      where: legalEntityId ? { legalEntityId } : {},
      include: { brackets: { orderBy: { ordinal: "asc" } } },
      orderBy: { effectiveFrom: "desc" },
    });
  }

  /**
   * The policy in force on a date, which is what a recalculation of an old
   * period must ask for so it returns the old figure (KEHOACH 9.7).
   */
  async effectiveAt(on: Date, legalEntityId: string | null): Promise<PolicyWithBrackets> {
    const found = await this.db.payrollPolicy.findFirst({
      where: {
        effectiveFrom: { lte: on },
        OR: [{ legalEntityId }, { legalEntityId: null }],
      },
      include: { brackets: { orderBy: { ordinal: "asc" } } },
      orderBy: [{ legalEntityId: "desc" }, { effectiveFrom: "desc" }],
    });
    if (!found) {
      throw new NotFoundException("POLICY_MISSING");
    }
    return found;
  }

  async create(body: CreatePolicyDto, createdById: string): Promise<PolicyWithBrackets> {
    const made = await this.db.payrollPolicy.create({
      data: {
        legalEntityId: body.legalEntityId ?? null,
        effectiveFrom: new Date(body.effectiveFrom),
        selfDeduction: body.selfDeduction,
        dependentDeduction: body.dependentDeduction,
        socialRateBp: body.socialRateBp,
        healthRateBp: body.healthRateBp,
        unemploymentRateBp: body.unemploymentRateBp,
        employerSocialRateBp: body.employerSocialRateBp,
        employerHealthRateBp: body.employerHealthRateBp,
        employerUnemploymentRateBp: body.employerUnemploymentRateBp,
        referenceWage: body.referenceWage,
        socialCapMultiple: body.socialCapMultiple,
        regionalMinimumWage: body.regionalMinimumWage,
        unemploymentCapMultiple: body.unemploymentCapMultiple,
        standardDaysPerMonth: body.standardDaysPerMonth,
        noContributionUnpaidDays: body.noContributionUnpaidDays,
        overtimeWeekdayBp: body.overtimeWeekdayBp,
        overtimeWeekendBp: body.overtimeWeekendBp,
        overtimeHolidayBp: body.overtimeHolidayBp,
        nightPremiumBp: body.nightPremiumBp,
        note: body.note ?? null,
        brackets: {
          create: body.brackets.map((bracket, index) => ({
            ordinal: index + 1,
            upToAmount: bracket.upToAmount ?? null,
            rateBp: bracket.rateBp,
          })),
        },
      },
      include: { brackets: { orderBy: { ordinal: "asc" } } },
    });
    await this.audit.record({
      actorId: createdById,
      action: "policy.create",
      target: made.id,
      meta: { effectiveFrom: body.effectiveFrom, brackets: body.brackets.length },
    });
    return made;
  }
}

/** The shape the calculation wants: integers, no Decimal, no database types. */
export function asCalcPolicy(policy: PolicyWithBrackets): CalcPolicy {
  return {
    selfDeduction: toDong(policy.selfDeduction),
    dependentDeduction: toDong(policy.dependentDeduction),
    socialRateBp: policy.socialRateBp,
    healthRateBp: policy.healthRateBp,
    unemploymentRateBp: policy.unemploymentRateBp,
    employerSocialRateBp: policy.employerSocialRateBp,
    employerHealthRateBp: policy.employerHealthRateBp,
    employerUnemploymentRateBp: policy.employerUnemploymentRateBp,
    referenceWage: toDong(policy.referenceWage),
    socialCapMultiple: policy.socialCapMultiple,
    regionalMinimumWage: toDong(policy.regionalMinimumWage),
    unemploymentCapMultiple: policy.unemploymentCapMultiple,
    standardDayHundredths: toHundredths(policy.standardDaysPerMonth),
    noContributionUnpaidDays: policy.noContributionUnpaidDays,
    overtimeWeekdayBp: policy.overtimeWeekdayBp,
    overtimeWeekendBp: policy.overtimeWeekendBp,
    overtimeHolidayBp: policy.overtimeHolidayBp,
    nightPremiumBp: policy.nightPremiumBp,
    brackets: policy.brackets.map((bracket) => ({
      upToAmount: bracket.upToAmount === null ? null : toDong(bracket.upToAmount),
      rateBp: bracket.rateBp,
    })),
  };
}
