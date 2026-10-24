import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  Prisma,
  type AllowanceType,
  type CompensationAllowance,
  type CompensationRecord,
  type Dependent,
} from "@prisma/client";

import { departmentSubtree } from "../../common/scope/department-subtree.js";
import { ScopeService } from "../../common/scope/scope.service.js";
import { refuseOwn, type Viewer } from "../../common/scope/viewer.js";
import { EXPORT_MAX_ROWS, toExcelCsv } from "../../common/csv.js";
import { COUNT_CEILING, countedTo, nextCursor, resumeAfter } from "../../common/dto/cursor.dto.js";
import type { Page } from "../../common/dto/pagination.dto.js";
import type { Env } from "../../config/env.schema.js";
import {
  FOREIGN_KEY_VIOLATION,
  isPrismaCode,
  PrismaService,
  RECORD_NOT_FOUND,
  UNIQUE_VIOLATION,
} from "../../database/prisma.service.js";
import { AUDIT_ACTIONS, AUDIT_SUBJECTS } from "../audit/audit-actions.js";
import { AuditService, trail, type AuditEntry } from "../audit/audit.service.js";
import type { BulkSkip } from "../employees/bulk.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { AudienceService } from "../notifications/audience.service.js";
import { NoticeItemsService } from "../notifications/notice-items.service.js";
import { namesOf } from "../notifications/notifications.service.js";
import type { Order } from "../leave/dto/queue.dto.js";
import {
  PERSON_VIEW,
  QUEUE_DESKS,
  filedBetween,
  personWhere,
  sortedBy,
} from "../leave/queue-filter.js";
import { asDay } from "../timesheet/local-day.js";

import {
  PAY_WRITERS,
  type BulkRaiseDto,
  type CreateAllowanceTypeDto,
  type CreateCompensationDto,
  type CreateDependentDto,
  type DecideDependentDto,
  type ListDependentsDto,
  type UpdateAllowanceTypeDto,
} from "./dto/compensation.dto.js";

export type PayRecord = CompensationRecord & { allowances: CompensationAllowance[] };

const DEPENDENT_EXPORT_COLUMNS = [
  "code", "fullName", "department", "dependentName", "relation", "fromMonth", "toMonth",
  "createdAt", "state", "decidedBy", "decidedAt", "decisionNote",
];

type ListedDependent = Prisma.DependentGetPayload<{ include: { employee: typeof PERSON_VIEW } }>;

export type QueuedDependent = ListedDependent & { decidedByName: string | null };

/** A first pay record an import line asks for; no `from` takes the hire date, then the fallback day. */
export interface FirstPay {
  code: string;
  from: string | null;
  base: string;
  insurance: string;
}

export interface RaisePreview {
  employeeId: number;
  code: string;
  fullName: string;
  currentBase: string;
  nextBase: string;
  currentInsurance: string;
  nextInsurance: string;
}

export interface RaisePlan {
  rows: RaisePreview[];
  skipped: BulkSkip[];
}

export interface RaiseWritten {
  written: number;
  skipped: BulkSkip[];
}

function dateTaken(person: { employeeId: number; code: string; fullName: string }): BulkSkip {
  return { employeeId: person.employeeId, code: person.code, fullName: person.fullName, reason: "PAY_DATE_TAKEN" };
}

// A first record has no earlier one, so its from is null (KEHOACH 9.24 rule 4).
function firstLine(actorId: string, employeeId: number, day: string, base: string): AuditEntry {
  return {
    actorId,
    action: AUDIT_ACTIONS.PAY_CREATE,
    subject: AUDIT_SUBJECTS.EMPLOYEE,
    subjectId: String(employeeId),
    meta: { effectiveFrom: day, from: null, to: base, reason: "HIRE", allowances: [] },
  };
}

@Injectable()
export class CompensationService {
  constructor(
    private readonly db: PrismaService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env, true>,
    private readonly notices: NotificationsService,
    private readonly audience: AudienceService,
    private readonly items: NoticeItemsService,
  ) {}

  allowanceTypes(all = false): Promise<AllowanceType[]> {
    return this.db.allowanceType.findMany({ where: all ? {} : { active: true }, orderBy: { code: "asc" } });
  }

  async createAllowanceType(viewer: Viewer, body: CreateAllowanceTypeDto): Promise<AllowanceType> {
    const made = await this.db.allowanceType
      .create({
        data: {
          code: body.code,
          name: body.name,
          taxable: body.taxable ?? true,
          insurable: body.insurable ?? false,
          taxFreeCap: body.taxFreeCap ?? null,
          d02Column: body.d02Column ?? null,
        },
      })
      .catch((error: unknown) => {
        throw isPrismaCode(error, UNIQUE_VIOLATION) ? new ConflictException("ALLOWANCE_CODE_TAKEN") : error;
      });
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.ALLOWANCE_TYPE_CREATE,
      subject: AUDIT_SUBJECTS.ALLOWANCE_TYPE,
      subjectId: made.id,
      meta: { code: made.code },
    });
    return made;
  }

  /** Pay records written earlier keep the copy they took, so an edit here reprices nothing past. */
  async updateAllowanceType(viewer: Viewer, id: string, body: UpdateAllowanceTypeDto): Promise<AllowanceType> {
    const held = await this.db.allowanceType.findUnique({ where: { id } });
    if (!held) {
      throw new NotFoundException("ALLOWANCE_TYPE_NOT_FOUND");
    }
    const saved = await this.db.allowanceType.update({ where: { id }, data: body }).catch((error: unknown) => {
      if (isPrismaCode(error, UNIQUE_VIOLATION)) {
        throw new ConflictException("ALLOWANCE_CODE_TAKEN");
      }
      throw isPrismaCode(error, RECORD_NOT_FOUND) ? new NotFoundException("ALLOWANCE_TYPE_NOT_FOUND") : error;
    });
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.ALLOWANCE_TYPE_UPDATE,
      subject: AUDIT_SUBJECTS.ALLOWANCE_TYPE,
      subjectId: id,
      meta: trail(held, body),
    });
    return saved;
  }

  /** The rows a pay record stores: each amount beside a copy of its type's rules. */
  private async allowanceRows(
    body: CreateCompensationDto,
  ): Promise<Prisma.CompensationAllowanceCreateWithoutRecordInput[]> {
    const wanted = body.allowances ?? [];
    if (wanted.length === 0) {
      return [];
    }
    const ids = wanted.map((one) => one.allowanceTypeId);
    if (new Set(ids).size !== ids.length) {
      throw new BadRequestException("ALLOWANCE_TYPE_REPEATED");
    }
    const types = await this.db.allowanceType.findMany({ where: { id: { in: ids }, active: true } });
    const typeOf = new Map(types.map((one) => [one.id, one]));
    return wanted.map((one) => {
      const type = typeOf.get(one.allowanceTypeId);
      if (!type) {
        throw new NotFoundException("ALLOWANCE_TYPE_NOT_FOUND");
      }
      return {
        type: { connect: { id: type.id } },
        code: type.code,
        label: type.name,
        amount: one.amount,
        taxable: type.taxable,
        insurable: type.insurable,
        taxFreeCap: type.taxFreeCap,
        d02Column: type.d02Column,
      };
    });
  }

  private async mayRead(viewer: Viewer, employeeId: number): Promise<void> {
    const visible = await this.scope.deskOrSelfEmployeeIds(viewer);
    if (!(await this.scope.reaches(viewer, visible, employeeId))) {
      // Not 403: a viewer who cannot see somebody should not learn they exist.
      throw new NotFoundException("EMPLOYEE_NOT_FOUND");
    }
  }

  private mayWrite(viewer: Viewer): void {
    if (!PAY_WRITERS.includes(viewer.role)) {
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
    // Setting one's own pay is the check the desk split exists for (KEHOACH 9.4).
    refuseOwn(viewer, body.employeeId);
    await this.mayRead(viewer, body.employeeId);
    const allowances = await this.allowanceRows(body);
    const held = await this.atDate(body.employeeId, new Date(body.effectiveFrom));
    const made = await this.db.compensationRecord
      .create({
        data: {
          employee: { connect: { id: body.employeeId } },
          effectiveFrom: new Date(body.effectiveFrom),
          baseSalary: body.baseSalary,
          insuranceSalary: body.insuranceSalary,
          reason: body.reason,
          note: body.note ?? null,
          createdById: viewer.userId,
          allowances: { create: allowances },
        },
        include: { allowances: true },
      })
      .catch((error: unknown) => {
        if (isPrismaCode(error, UNIQUE_VIOLATION)) {
          throw new ConflictException("PAY_DATE_TAKEN");
        }
        throw isPrismaCode(error, FOREIGN_KEY_VIOLATION) || isPrismaCode(error, RECORD_NOT_FOUND)
          ? new NotFoundException("EMPLOYEE_NOT_FOUND")
          : error;
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
        allowances: made.allowances.map((one) => ({ code: one.code, amount: String(one.amount) })),
      },
    });
    return made;
  }

  /** Write a person's first pay record under the rules of create, or keep the one they have (KEHOACH 9.6).
   *  @ctx inside the caller's transaction | record the line once it commits | PAY_WRITE_DENIED, SELF_DECISION
   *  @ret the record written with its trail line, or the newest one held and no line
   */
  async stageFirst(
    tx: Prisma.TransactionClient,
    viewer: Viewer,
    employeeId: number,
    effectiveFrom: Date,
    pay: { baseSalary: number; insuranceSalary: number },
  ): Promise<{ id: string; line: AuditEntry | null }> {
    this.mayWrite(viewer);
    refuseOwn(viewer, employeeId);
    // Held to the commit, so two passes at once cannot both find the person unpaid.
    await tx.$queryRaw`SELECT "id" FROM "Employee" WHERE "id" = ${employeeId} FOR UPDATE`;
    const held = await tx.compensationRecord.findFirst({
      where: { employeeId },
      orderBy: { effectiveFrom: "desc" },
      select: { id: true },
    });
    if (held) {
      return { id: held.id, line: null };
    }
    const made = await tx.compensationRecord.create({
      data: {
        employeeId,
        effectiveFrom,
        baseSalary: pay.baseSalary,
        insuranceSalary: pay.insuranceSalary,
        reason: "HIRE",
        createdById: viewer.userId,
      },
    });
    const day = asDay(made.effectiveFrom);
    return { id: made.id, line: firstLine(viewer.userId, employeeId, day, made.baseSalary.toFixed(0)) };
  }

  /** Write the first pay record of every listed person who has none, in one statement (KEHOACH 9.6).
   *  @ctx inside the caller's transaction | the import's plan has refused the importer's own line
   *  @ret the trail lines to record once the transaction commits
   */
  async seedFirst(tx: Prisma.TransactionClient, actorId: string, rows: readonly FirstPay[], fallbackDay: string): Promise<AuditEntry[]> {
    const made = await tx.$queryRaw<{ employeeId: number; day: string; base: string }[]>`
      INSERT INTO "CompensationRecord" (
        "id", "employeeId", "effectiveFrom", "baseSalary", "insuranceSalary",
        "reason", "createdById", "createdAt")
      SELECT gen_random_uuid(), e."id", COALESCE(v."from"::date, e."hireDate", ${fallbackDay}::date),
             v."base"::numeric, v."insurance"::numeric,
             'HIRE'::"PayReason", ${actorId}, now()
        FROM unnest(${rows.map((row) => row.code)}::text[],
                    ${rows.map((row) => row.from)}::text[],
                    ${rows.map((row) => row.base)}::text[],
                    ${rows.map((row) => row.insurance)}::text[])
             AS v("code", "from", "base", "insurance")
        JOIN "Employee" e ON e."code" = v."code"
       WHERE NOT EXISTS (SELECT 1 FROM "CompensationRecord" c WHERE c."employeeId" = e."id")
      ON CONFLICT ("employeeId", "effectiveFrom") DO NOTHING
      RETURNING "employeeId", "effectiveFrom"::text AS "day", "baseSalary"::text AS "base"
    `;
    return made.map((one) => firstLine(actorId, one.employeeId, one.day, one.base));
  }

  /** What a bulk raise would write, while it is still only a proposal. The
   *  writer's own record is left out, as it would be refused one at a time.
   */
  async previewRaise(viewer: Viewer, body: BulkRaiseDto): Promise<RaisePlan> {
    this.mayWrite(viewer);
    refuseOwn(viewer);
    const on = new Date(body.effectiveFrom);
    const chosen = body.employeeIds?.length ? body.employeeIds : null;
    const branch = body.departmentId ? await departmentSubtree(this.db, body.departmentId) : null;
    const visible = await this.scope.deskOrSelfEmployeeIds(viewer);
    const self = viewer.employeeId ?? 0;
    // DISTINCT ON takes each latest record in one pass; a query per employee breaks at a few thousand (KEHOACH 9.9).
    const rows = await this.db.$queryRaw<
      { employeeId: number; code: string; fullName: string; baseSalary: string; insuranceSalary: string; taken: boolean }[]
    >`
      SELECT DISTINCT ON (e."id")
             e."id" AS "employeeId", e."code", e."fullName",
             c."baseSalary"::text, c."insuranceSalary"::text,
             EXISTS (SELECT 1 FROM "CompensationRecord" t
                      WHERE t."employeeId" = e."id" AND t."effectiveFrom" = ${on}) AS "taken"
        FROM "Employee" e
        JOIN "CompensationRecord" c ON c."employeeId" = e."id"
       WHERE e."active" = true
         AND e."id" <> ${self}
         AND ${ScopeService.peopleSql(viewer, visible, Prisma.sql`e."id"`, Prisma.sql`e."legalEntityId"`)}
         AND c."effectiveFrom" <= ${on}
         AND (${branch}::text[] IS NULL OR e."departmentId" = ANY(${branch}::text[]))
         AND (${chosen}::int[] IS NULL OR e."id" = ANY(${chosen}::int[]))
       ORDER BY e."id", c."effectiveFrom" DESC
    `;
    const step = body.percentBp;
    const raised = (from: bigint): bigint =>
      step === undefined ? from + BigInt(body.amount ?? 0) : from + (from * BigInt(step)) / 10_000n;
    rows.sort((left, right) => left.code.localeCompare(right.code));
    return {
      rows: rows
        .filter((row) => !row.taken)
        .map((row) => {
          const base = BigInt(row.baseSalary.split(".")[0]);
          const insurance = BigInt(row.insuranceSalary.split(".")[0]);
          return {
            employeeId: row.employeeId,
            code: row.code,
            fullName: row.fullName,
            currentBase: base.toString(),
            nextBase: raised(base).toString(),
            currentInsurance: insurance.toString(),
            nextInsurance: (body.raiseInsuranceSalary ? raised(insurance) : insurance).toString(),
          };
        }),
      skipped: rows.filter((row) => row.taken).map(dateTaken),
    };
  }

  async applyRaise(viewer: Viewer, body: BulkRaiseDto): Promise<RaiseWritten> {
    const plan = await this.previewRaise(viewer, body);
    const on = new Date(body.effectiveFrom);
    const rows: Prisma.CompensationRecordCreateManyInput[] = plan.rows.map((one) => ({
      employeeId: one.employeeId,
      effectiveFrom: on,
      baseSalary: one.nextBase,
      insuranceSalary: one.nextInsurance,
      reason: body.reason,
      note: body.note ?? null,
      createdById: viewer.userId,
    }));
    const landed = await this.db.$transaction(async (tx) => {
      const made = await tx.compensationRecord.createManyAndReturn({
        data: rows,
        skipDuplicates: true,
        select: { employeeId: true },
      });
      const fresh = made.map((one) => one.employeeId);
      // A raise changes base pay only; without this the allowances drop out of the next payslip.
      await tx.$executeRaw`
        INSERT INTO "CompensationAllowance"
               ("id", "recordId", "typeId", "code", "label", "amount", "taxable", "insurable", "taxFreeCap", "d02Column")
        SELECT gen_random_uuid()::text, n."id", a."typeId", a."code", a."label", a."amount",
               a."taxable", a."insurable", a."taxFreeCap", a."d02Column"
          FROM "CompensationRecord" n
          JOIN LATERAL (
            SELECT p."id" FROM "CompensationRecord" p
             WHERE p."employeeId" = n."employeeId" AND p."effectiveFrom" < n."effectiveFrom"
             ORDER BY p."effectiveFrom" DESC LIMIT 1
          ) prev ON true
          JOIN "CompensationAllowance" a ON a."recordId" = prev."id"
         WHERE n."effectiveFrom" = ${on}
           AND n."employeeId" = ANY(${fresh}::int[])
        ON CONFLICT ("recordId", "code") DO NOTHING
      `;
      return new Set(fresh);
    });
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.PAY_BULK_RAISE,
      subject: AUDIT_SUBJECTS.ORG,
      subjectId: body.departmentId ?? "selection",
      meta: { effectiveFrom: body.effectiveFrom, written: landed.size },
    });
    const raced = plan.rows.filter((one) => !landed.has(one.employeeId)).map(dateTaken);
    return { written: landed.size, skipped: [...plan.skipped, ...raced] };
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

  /** Registrations narrowed to this viewer's people: the queue to decide with PENDING, the register
   *  with every state (KEHOACH 9.15). An approval nobody can find is an approval that never happens.
   */
  async dependentQueue(viewer: Viewer, query: ListDependentsDto): Promise<Page<QueuedDependent>> {
    const { where, order } = await this.dependentsSelected(viewer, query);
    const [rows, found] = await Promise.all([
      this.db.dependent.findMany({
        where: { AND: [where, resumeAfter("createdAt", order, query.cursor)] },
        include: { employee: PERSON_VIEW },
        orderBy: sortedBy("createdAt", order),
        take: query.take,
      }),
      this.db.dependent.count({ where, take: COUNT_CEILING + 1 }),
    ]);
    return { rows: await this.named(rows), ...countedTo(found), next: nextCursor(rows, query.take, (row) => row.createdAt) };
  }

  /** The register's dependants under the same filter, as a file Excel opens; no identity numbers (KEHOACH 9.15). */
  async exportDependents(viewer: Viewer, query: ListDependentsDto): Promise<string> {
    const { where, order } = await this.dependentsSelected(viewer, query);
    const rows = await this.named(
      await this.db.dependent.findMany({
        where,
        include: { employee: PERSON_VIEW },
        orderBy: sortedBy("createdAt", order),
        take: EXPORT_MAX_ROWS,
      }),
    );
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.EXPORT_DEPENDENTS,
      subject: AUDIT_SUBJECTS.EXPORT,
      subjectId: "dependents",
      meta: { filters: { ...query }, rows: rows.length },
    });
    return toExcelCsv(
      DEPENDENT_EXPORT_COLUMNS,
      rows.map((row) => [
        row.employee.code,
        row.employee.fullName,
        row.employee.department?.name ?? "",
        row.fullName,
        row.relation,
        asDay(row.fromMonth).slice(0, 7),
        asDay(row.toMonth)?.slice(0, 7) ?? "",
        row.createdAt.toISOString(),
        row.state,
        row.decidedByName ?? "",
        row.decidedAt?.toISOString() ?? "",
        row.decisionNote ?? "",
      ]),
    );
  }

  private async dependentsSelected(
    viewer: Viewer,
    query: ListDependentsDto,
  ): Promise<{ where: Prisma.DependentWhereInput; order: Order }> {
    const waiting = query.state === "PENDING";
    const [visible, person] = await Promise.all([
      this.scope.deskOrSelfEmployeeIds(viewer),
      personWhere(this.db, query),
    ]);
    const where: Prisma.DependentWhereInput = {
      AND: [
        query.state ? { state: query.state } : {},
        ScopeService.ownedWhere(viewer, visible),
        query.employeeId === undefined ? {} : { employeeId: query.employeeId },
        await this.audience.inboxNarrowing(viewer, "DEPENDENTS", waiting, query.employeeId),
        person ? { employee: person } : {},
        filedBetween("createdAt", query, this.config.get("APP_TIMEZONE", { infer: true })),
      ],
    };
    return { where, order: query.order ?? (waiting ? "asc" : "desc") };
  }

  private async named(rows: ListedDependent[]): Promise<QueuedDependent[]> {
    const names = await namesOf(this.db, rows.map((row) => row.decidedById));
    return rows.map((row) => ({ ...row, decidedByName: row.decidedById ? (names.get(row.decidedById) ?? null) : null }));
  }

  /** One record through the list's own scope, so the inbox opens it wherever it sits in the queue (KEHOACH 9.21.4). */
  async oneDependent(viewer: Viewer, id: string): Promise<QueuedDependent> {
    const visible = await this.scope.deskOrSelfEmployeeIds(viewer);
    const held = await this.db.dependent.findUnique({ where: { id }, include: { employee: PERSON_VIEW } });
    if (!held || !(await this.scope.reaches(viewer, visible, held.employeeId))) {
      throw new NotFoundException("DEPENDENT_NOT_FOUND");
    }
    const [row] = await this.named([held]);
    return row;
  }

  async addDependent(viewer: Viewer, body: CreateDependentDto): Promise<Dependent> {
    const employeeId = body.employeeId ?? viewer.employeeId;
    if (employeeId === null || employeeId === undefined) {
      throw new NotFoundException("EMPLOYEE_NOT_FOUND");
    }
    await this.mayRead(viewer, employeeId);
    const made = await this.db.dependent
      .create({
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
      })
      .catch((error: unknown) => {
        throw isPrismaCode(error, FOREIGN_KEY_VIOLATION) ? new NotFoundException("EMPLOYEE_NOT_FOUND") : error;
      });
    await this.items.open("DEPENDENTS", made);
    return made;
  }

  /** The state moves only out of PENDING, claimed by the update itself, so
   *  two desks answering at once cannot both win.
   */
  async decideDependent(viewer: Viewer, id: string, body: DecideDependentDto): Promise<Dependent> {
    if (!QUEUE_DESKS.dependents.includes(viewer.role)) {
      throw new ForbiddenException("PAY_WRITE_DENIED");
    }
    const held = await this.db.dependent.findUnique({ where: { id }, select: { employeeId: true } });
    const visible = await this.scope.deskOrSelfEmployeeIds(viewer);
    if (!held || !(await this.scope.reaches(viewer, visible, held.employeeId))) {
      throw new NotFoundException("DEPENDENT_NOT_FOUND");
    }
    // A dependent lowers the claimant's own tax, so the claimant never approves it (KEHOACH 9.4).
    refuseOwn(viewer, held.employeeId);
    const claimed = await this.db.dependent.updateMany({
      where: { id, state: "PENDING" },
      data: {
        state: body.approve ? "ACTIVE" : "REJECTED",
        decidedById: viewer.userId,
        decidedAt: new Date(),
        decisionNote: body.note ?? null,
      },
    });
    if (claimed.count === 0) {
      throw new ConflictException("REQUEST_ALREADY_DECIDED");
    }
    await this.audit.record({
      actorId: viewer.userId,
      action: body.approve ? AUDIT_ACTIONS.DEPENDENT_APPROVE : AUDIT_ACTIONS.DEPENDENT_REJECT,
      subject: AUDIT_SUBJECTS.EMPLOYEE,
      subjectId: String(held.employeeId),
      meta: { dependentId: id },
    });
    await this.items.close("DEPENDENTS", id, {
      state: "DONE",
      outcome: body.approve ? "APPROVED" : "REJECTED",
      actorId: viewer.userId,
    });
    await this.notices.raiseFor(held.employeeId, "REQUEST_DECIDED", { dependentId: id, approved: body.approve });
    return this.db.dependent.findUniqueOrThrow({ where: { id } });
  }
}
