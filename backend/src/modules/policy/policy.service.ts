import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { PayrollPolicy, TaxBracket } from "@prisma/client";

import { PrismaService } from "../../database/prisma.service.js";
import { AUDIT_ACTIONS, AUDIT_SUBJECTS } from "../audit/audit-actions.js";
import { AuditService } from "../audit/audit.service.js";
import type { CalcPolicy } from "../payroll/calculate.js";
import { toDong, toHundredths } from "../payroll/money.js";
import type { CreatePolicyDto } from "./dto/policy.dto.js";

export type PolicyWithBrackets = PayrollPolicy & { brackets: TaxBracket[] };

const UNIQUE_VIOLATION = "P2002";

/** Bands climb strictly and only the last one is open-ended, or the tax walk skips or repeats a slice. */
function bandsInOrder(brackets: CreatePolicyDto["brackets"]): boolean {
  return brackets.every((band, at) => {
    const last = at === brackets.length - 1;
    if (band.upToAmount === undefined || band.upToAmount === null) {
      return last;
    }
    const below = at === 0 ? -1 : (brackets[at - 1].upToAmount ?? Number.POSITIVE_INFINITY);
    return band.upToAmount > below;
  });
}

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
      // An entity's own row outranks the company-wide one, which Postgres sorts first when descending.
      orderBy: [{ legalEntityId: { sort: "desc", nulls: "last" } }, { effectiveFrom: "desc" }],
    });
    if (!found) {
      throw new NotFoundException("POLICY_MISSING");
    }
    return found;
  }

  async create(body: CreatePolicyDto, createdById: string): Promise<PolicyWithBrackets> {
    if (!bandsInOrder(body.brackets)) {
      throw new BadRequestException("BRACKETS_OUT_OF_ORDER");
    }
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
    }).catch((error: unknown) => {
      if (typeof error === "object" && error !== null && "code" in error && error.code === UNIQUE_VIOLATION) {
        throw new ConflictException("POLICY_DATE_TAKEN");
      }
      throw error;
    });
    await this.audit.record({
      actorId: createdById,
      action: AUDIT_ACTIONS.POLICY_CREATE,
      subject: AUDIT_SUBJECTS.POLICY,
      subjectId: made.id,
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
