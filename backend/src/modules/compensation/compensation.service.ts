import { ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type {
  CompensationAllowance,
  CompensationRecord,
  Dependent,
  DependentState,
  Prisma,
} from "@prisma/client";

import { ScopeService } from "../../common/scope/scope.service.js";
import type { Viewer } from "../../common/scope/viewer.js";
import { PrismaService } from "../../database/prisma.service.js";
import { AUDIT_ACTIONS, AUDIT_SUBJECTS } from "../audit/audit-actions.js";
import { AuditService } from "../audit/audit.service.js";

import type {
  BulkRaiseDto,
  CreateCompensationDto,
  CreateDependentDto,
  DecideDependentDto,
} from "./dto/compensation.dto.js";

export type PayRecord = CompensationRecord & { allowances: CompensationAllowance[] };

export interface RaisePreview {
  employeeId: number;
  code: string;
  fullName: string;
  currentBase: string;
  nextBase: string;
}

const WRITERS: ReadonlySet<string> = new Set(["ADMIN", "PAYROLL"]);
const kQueuePage = 200;

@Injectable()
export class CompensationService {
  constructor(
    private readonly db: PrismaService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
  ) {}

  private async mayRead(viewer: Viewer, employeeId: number): Promise<void> {
    const visible = await this.scope.visibleEmployeeIds(viewer);
    if (visible !== null && !visible.includes(employeeId)) {
      // Not 403: a viewer who cannot see somebody should not learn they exist.
      throw new NotFoundException("EMPLOYEE_NOT_FOUND");
    }
  }

  private mayWrite(viewer: Viewer): void {
    if (!WRITERS.has(viewer.role)) {
      throw new ForbiddenException("PAY_WRITE_DENIED");
    }
  }

  async history(viewer: Viewer, employeeId: number): Promise<PayRecord[]> {
    await this.mayRead(viewer, employeeId);
    return this.db.compensationRecord.findMany({
      where: { employeeId },
      include: { allowances: true },
      orderBy: { effectiveFrom: "desc" },
    });
  }

  /** The record in force on a date; a later raise never reaches back (KEHOACH 9.6). */
  atDate(employeeId: number, on: Date): Promise<PayRecord | null> {
    return this.db.compensationRecord.findFirst({
      where: { employeeId, effectiveFrom: { lte: on } },
      include: { allowances: true },
      orderBy: { effectiveFrom: "desc" },
    });
  }

  async create(viewer: Viewer, body: CreateCompensationDto): Promise<PayRecord> {
    this.mayWrite(viewer);
    const held = await this.atDate(body.employeeId, new Date(body.effectiveFrom));
    const made = await this.db.compensationRecord.create({
      data: {
        employeeId: body.employeeId,
        effectiveFrom: new Date(body.effectiveFrom),
        baseSalary: body.baseSalary,
        insuranceSalary: body.insuranceSalary,
        reason: body.reason,
        note: body.note ?? null,
        createdById: viewer.userId,
        allowances: {
          create: (body.allowances ?? []).map((allowance) => ({
            code: allowance.code,
            label: allowance.label,
            amount: allowance.amount,
            taxable: allowance.taxable ?? true,
            insurable: allowance.insurable ?? false,
          })),
        },
      },
      include: { allowances: true },
    });
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.PAY_CREATE,
      subject: AUDIT_SUBJECTS.EMPLOYEE,
      subjectId: String(body.employeeId),
      meta: {
        effectiveFrom: body.effectiveFrom,
        from: held ? String(held.baseSalary) : null,
        to: String(body.baseSalary),
        reason: body.reason,
      },
    });
    return made;
  }

  /** What a bulk raise would write, while it is still only a proposal. */
  async previewRaise(viewer: Viewer, body: BulkRaiseDto): Promise<RaisePreview[]> {
    this.mayWrite(viewer);
    const on = new Date(body.effectiveFrom);
    const chosen = body.employeeIds?.length ? body.employeeIds : null;
    // DISTINCT ON takes the latest record per person in one pass; asking per
    // employee is one query each, which stops working at a few thousand (KEHOACH 9.9).
    const rows = await this.db.$queryRaw<
      { employeeId: number; code: string; fullName: string; baseSalary: string }[]
    >`
      SELECT DISTINCT ON (e."id")
             e."id" AS "employeeId", e."code", e."fullName", c."baseSalary"::text
        FROM "Employee" e
        JOIN "CompensationRecord" c ON c."employeeId" = e."id"
       WHERE e."active" = true
         AND c."effectiveFrom" <= ${on}
         AND (${body.departmentId ?? null}::text IS NULL OR e."departmentId" = ${body.departmentId ?? null})
         AND (${chosen}::int[] IS NULL OR e."id" = ANY(${chosen}::int[]))
       ORDER BY e."id", c."effectiveFrom" DESC
    `;
    const step = body.percentBp;
    return rows
      .map((row) => {
        const base = BigInt(row.baseSalary.split(".")[0]);
        const next =
          step === undefined ? base + BigInt(body.amount ?? 0) : base + (base * BigInt(step)) / 10_000n;
        return {
          employeeId: row.employeeId,
          code: row.code,
          fullName: row.fullName,
          currentBase: base.toString(),
          nextBase: next.toString(),
        };
      })
      .sort((left, right) => left.code.localeCompare(right.code));
  }

  async applyRaise(viewer: Viewer, body: BulkRaiseDto): Promise<{ written: number }> {
    const preview = await this.previewRaise(viewer, body);
    const on = new Date(body.effectiveFrom);
    const rows: Prisma.CompensationRecordCreateManyInput[] = preview.map((one) => ({
      employeeId: one.employeeId,
      effectiveFrom: on,
      baseSalary: one.nextBase,
      insuranceSalary: body.raiseInsuranceSalary ? one.nextBase : one.currentBase,
      reason: body.reason,
      note: body.note ?? null,
      createdById: viewer.userId,
    }));
    const written = await this.db.compensationRecord.createMany({ data: rows, skipDuplicates: true });
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.PAY_BULK_RAISE,
      subject: AUDIT_SUBJECTS.ORG,
      subjectId: body.departmentId ?? "selection",
      meta: { effectiveFrom: body.effectiveFrom, written: written.count },
    });
    return { written: written.count };
  }

  async dependents(viewer: Viewer, employeeId: number): Promise<Dependent[]> {
    await this.mayRead(viewer, employeeId);
    return this.db.dependent.findMany({ where: { employeeId }, orderBy: { fromMonth: "desc" } });
  }

  /** How many dependants deduct in a month; one registered later does not. */
  countActive(employeeId: number, monthEnd: Date): Promise<number> {
    return this.db.dependent.count({
      where: {
        employeeId,
        state: "ACTIVE",
        fromMonth: { lte: monthEnd },
        OR: [{ toMonth: null }, { toMonth: { gte: monthEnd } }],
      },
    });
  }

  /** What is waiting on a decision, narrowed to this viewer's people. An
   *  approval nobody can find is an approval that never happens.
   */
  async dependentQueue(viewer: Viewer, state: DependentState): Promise<Dependent[]> {
    const visible = await this.scope.visibleEmployeeIds(viewer);
    return this.db.dependent.findMany({
      where: { state, ...(visible === null ? {} : { employeeId: { in: visible } }) },
      include: { employee: { select: { id: true, code: true, fullName: true } } },
      orderBy: { createdAt: "asc" },
      take: kQueuePage,
    });
  }

  async addDependent(viewer: Viewer, body: CreateDependentDto): Promise<Dependent> {
    const employeeId = body.employeeId ?? viewer.employeeId;
    if (employeeId === null || employeeId === undefined) {
      throw new NotFoundException("EMPLOYEE_NOT_FOUND");
    }
    await this.mayRead(viewer, employeeId);
    return this.db.dependent.create({
      data: {
        employeeId,
        fullName: body.fullName,
        relation: body.relation,
        dateOfBirth: body.dateOfBirth ? new Date(body.dateOfBirth) : null,
        taxCode: body.taxCode ?? null,
        nationalId: body.nationalId ?? null,
        fromMonth: new Date(body.fromMonth),
        toMonth: body.toMonth ? new Date(body.toMonth) : null,
      },
    });
  }

  async decideDependent(viewer: Viewer, id: string, body: DecideDependentDto): Promise<Dependent> {
    this.mayWrite(viewer);
    return this.db.dependent.update({
      where: { id },
      data: {
        state: body.approve ? "ACTIVE" : "REJECTED",
        decidedById: viewer.userId,
        decidedAt: new Date(),
        decisionNote: body.note ?? null,
      },
    });
  }
}
