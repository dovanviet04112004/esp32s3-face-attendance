import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { PayrollPolicy, TaxBracket } from "@prisma/client";

import { ScopeService } from "../../common/scope/scope.service.js";
import type { Viewer } from "../../common/scope/viewer.js";
import { isPrismaCode, PrismaService, UNIQUE_VIOLATION } from "../../database/prisma.service.js";
import { AUDIT_ACTIONS, AUDIT_SUBJECTS } from "../audit/audit-actions.js";
import { AuditService } from "../audit/audit.service.js";
import type { CalcPolicy } from "../payroll/calculate.js";
import { toDong, toHundredths } from "../payroll/money.js";
import type { CreatePolicyDto } from "./dto/policy.dto.js";

export type PolicyWithBrackets = PayrollPolicy & { brackets: TaxBracket[] };

/** Ceilings climb strictly on every band but the last, which has none, or the tax walk skips,
 *  repeats or never taxes a slice. */
function bandsInOrder(brackets: CreatePolicyDto["brackets"]): boolean {
  return brackets.every((band, at) => {
    const last = at === brackets.length - 1;
    if (band.upToAmount === undefined || band.upToAmount === null) {
      return last;
    }
    const below = at === 0 ? -1 : (brackets[at - 1].upToAmount ?? Number.POSITIVE_INFINITY);
    return !last && band.upToAmount > below;
  });
}

@Injectable()
export class PolicyService {
  constructor(
    private readonly db: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(viewer: Viewer, legalEntityId?: string): Promise<PolicyWithBrackets[]> {
    return this.db.payrollPolicy.findMany({
      where: { ...(legalEntityId ? { legalEntityId } : {}), ...ScopeService.entityWhere(viewer, true) },
      include: { brackets: { orderBy: { ordinal: "asc" } } },
      orderBy: { effectiveFrom: "desc" },
    });
  }

  /**
   * The policy in force on a date, which is what a recalculation of an old
   * period must ask for so it returns the old figure (KEHOACH 9.7).
   */
  /** The policy in force for an entity the viewer answers for; another entity's answers as absent (KEHOACH 9.4). */
  async effectiveFor(viewer: Viewer, on: Date, legalEntityId: string | null): Promise<PolicyWithBrackets> {
    if (!ScopeService.reachesEntity(viewer, legalEntityId)) {
      throw new NotFoundException("LEGAL_ENTITY_NOT_FOUND");
    }
    return this.effectiveAt(on, legalEntityId);
  }

  async effectiveAt(on: Date, legalEntityId: string | null): Promise<PolicyWithBrackets> {
    return (await this.inForce(on, [legalEntityId])).get(legalEntityId) as PolicyWithBrackets;
  }

  /**
   * The policy in force on a date for each entity asked about: the entity's own
   * row, else the company-wide one (KEHOACH 9.7). One entity without either
   * refuses them all, so no run prices a part of its people.
   */
  async inForce(on: Date, legalEntityIds: readonly (string | null)[]): Promise<Map<string | null, PolicyWithBrackets>> {
    const wanted = [...new Set(legalEntityIds)];
    const rows = await this.db.payrollPolicy.findMany({
      where: {
        effectiveFrom: { lte: on },
        OR: [{ legalEntityId: { in: wanted.filter((one) => one !== null) } }, { legalEntityId: null }],
      },
      include: { brackets: { orderBy: { ordinal: "asc" } } },
      orderBy: { effectiveFrom: "desc" },
    });
    const companyWide = rows.find((row) => row.legalEntityId === null);
    const found = new Map<string | null, PolicyWithBrackets>();
    for (const entity of wanted) {
      const policy = rows.find((row) => entity !== null && row.legalEntityId === entity) ?? companyWide;
      if (!policy) {
        throw new NotFoundException("POLICY_MISSING");
      }
      found.set(entity, policy);
    }
    return found;
  }

  async create(body: CreatePolicyDto, viewer: Viewer): Promise<PolicyWithBrackets> {
    // A row with no entity prices the whole group, so only a desk that answers for it writes one (KEHOACH 9.4).
    if (!body.legalEntityId) {
      ScopeService.mustWriteGroup(viewer);
    } else if (!ScopeService.reachesEntity(viewer, body.legalEntityId)) {
      throw new NotFoundException("LEGAL_ENTITY_NOT_FOUND");
    }
    const createdById = viewer.userId;
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
      if (isPrismaCode(error, UNIQUE_VIOLATION)) {
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
