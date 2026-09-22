import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type {
  Department,
  EmploymentContract,
  Holiday,
  JobTitle,
  LegalEntity,
} from "@prisma/client";

import { ScopeService } from "../../common/scope/scope.service.js";
import type { Viewer } from "../../common/scope/viewer.js";
import { PrismaService } from "../../database/prisma.service.js";
import { AUDIT_ACTIONS, AUDIT_SUBJECTS } from "../audit/audit-actions.js";
import { AuditService } from "../audit/audit.service.js";
import type {
  CreateContractDto,
  CreateDepartmentDto,
  CreateHolidayDto,
  DecideContractDto,
  ReorgDto,
  UpdateDepartmentDto,
} from "./dto/org.dto.js";

const UNIQUE_VIOLATION = "P2002";

function byManager(
  rows: ReorgRow[],
  pick: (row: ReorgRow) => string | null,
): { managerCode: string; employees: string[] }[] {
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const boss = pick(row);
    if (boss === null) {
      continue;
    }
    grouped.set(boss, [...(grouped.get(boss) ?? []), row.code]);
  }
  return [...grouped].map(([managerCode, employees]) => ({ managerCode, employees }));
}

/** One person a reorganisation would move, and what it moves them out of. */
/** A department plus the people filed directly under it, not its subtree. */
export interface DepartmentNode extends Department {
  headcount: number;
}

export interface ReorgRow {
  employeeId: number;
  code: string;
  fullName: string;
  fromDepartment: string | null;
  toDepartment: string | null;
  fromManager: string | null;
  toManager: string | null;
  pendingRequests: number;
}

export interface ReorgPlan {
  applied: boolean;
  moving: ReorgRow[];
  losingSight: { managerCode: string; employees: string[] }[];
  gainingSight: { managerCode: string; employees: string[] }[];
  requestsReassigned: number;
}

@Injectable()
export class OrgService {
  constructor(
    private readonly db: PrismaService,
    private readonly audit: AuditService,
    private readonly scope: ScopeService,
  ) {}

  /**
   * What a reorganisation would do, and then, on request, doing it. The two
   * share one code path so the preview cannot describe a different move from
   * the one that lands (KEHOACH 9.18 item 7).
   */
  async reorg(viewer: Viewer, body: ReorgDto, apply: boolean): Promise<ReorgPlan> {
    // A body with nothing to narrow by would move the whole company, which is
    // one typo away from a department id that came out empty.
    if (!body.employeeCodes?.length && !body.fromDepartmentId) {
      throw new BadRequestException("REORG_NEEDS_A_SELECTION");
    }
    if (!body.toDepartmentId && !body.toManagerCode) {
      throw new BadRequestException("REORG_NEEDS_A_DESTINATION");
    }
    const people = await this.db.employee.findMany({
      where: {
        active: true,
        ...(body.employeeCodes ? { code: { in: body.employeeCodes } } : {}),
        ...(body.fromDepartmentId ? { departmentId: body.fromDepartmentId } : {}),
      },
      select: {
        id: true,
        code: true,
        fullName: true,
        department: { select: { code: true } },
        manager: { select: { code: true } },
      },
      orderBy: { code: "asc" },
    });
    if (people.length === 0) {
      throw new NotFoundException("REORG_MOVES_NOBODY");
    }

    const toDepartment = body.toDepartmentId
      ? await this.db.department.findUnique({
          where: { id: body.toDepartmentId },
          select: { id: true, code: true },
        })
      : null;
    if (body.toDepartmentId && !toDepartment) {
      throw new NotFoundException("DEPARTMENT_NOT_FOUND");
    }
    const toManager = body.toManagerCode
      ? await this.db.employee.findUnique({
          where: { code: body.toManagerCode },
          select: { id: true, code: true },
        })
      : null;
    if (body.toManagerCode && !toManager) {
      throw new NotFoundException("EMPLOYEE_NOT_FOUND");
    }

    const ids = people.map((one) => one.id);
    if (toManager && ids.includes(toManager.id)) {
      throw new ConflictException("MANAGER_CYCLE");
    }
    const waiting = await this.db.request.groupBy({
      by: ["employeeId"],
      where: { employeeId: { in: ids }, state: "PENDING" },
      _count: { _all: true },
    });
    const waitingBy = new Map(waiting.map((one) => [one.employeeId, one._count._all]));

    const moving: ReorgRow[] = people.map((one) => ({
      employeeId: one.id,
      code: one.code,
      fullName: one.fullName,
      fromDepartment: one.department?.code ?? null,
      toDepartment: toDepartment?.code ?? one.department?.code ?? null,
      fromManager: one.manager?.code ?? null,
      toManager: toManager ? toManager.code : (one.manager?.code ?? null),
      pendingRequests: waitingBy.get(one.id) ?? 0,
    }));

    const changingBoss = moving.filter((one) => one.fromManager !== one.toManager);
    const plan: ReorgPlan = {
      applied: false,
      moving,
      losingSight: byManager(changingBoss, (one) => one.fromManager),
      gainingSight: byManager(changingBoss, (one) => one.toManager),
      requestsReassigned: changingBoss.reduce((total, one) => total + one.pendingRequests, 0),
    };
    if (!apply) {
      return plan;
    }

    await this.db.$transaction(async (tx) => {
      await tx.employee.updateMany({
        where: { id: { in: ids } },
        data: {
          ...(toDepartment ? { departmentId: toDepartment.id } : {}),
          ...(toManager ? { managerId: toManager.id } : {}),
        },
      });
      await this.scope.assertNoManagerCycle(tx, ids);
      // Left with its old approver, a request reaches somebody who lacks the
      // standing to see the person, so nobody can answer it.
      if (toManager) {
        await tx.request.updateMany({
          where: { employeeId: { in: ids }, state: "PENDING" },
          data: { approverId: toManager.id },
        });
      }
    });
    await this.scope.forgetScopes();
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.ORG_REORG,
      subject: AUDIT_SUBJECTS.ORG,
      subjectId: toDepartment?.code ?? "selection",
      meta: { moved: ids.length, toDepartment: toDepartment?.code, toManager: toManager?.code },
    });
    return { ...plan, applied: true };
  }

  holidays(year?: number): Promise<Holiday[]> {
    const from = new Date(Date.UTC(year ?? new Date().getUTCFullYear(), 0, 1));
    const to = new Date(Date.UTC((year ?? new Date().getUTCFullYear()) + 1, 0, 0));
    return this.db.holiday.findMany({
      where: { date: { gte: from, lte: to } },
      orderBy: { date: "asc" },
    });
  }

  /**
   * Without a row here a public holiday reads as absent and is docked from
   * pay, because the day build has nothing else to tell them apart.
   */
  async addHoliday(body: CreateHolidayDto, actorId: string): Promise<Holiday> {
    try {
      const made = await this.db.holiday.create({
        data: {
          legalEntityId: body.legalEntityId ?? null,
          date: new Date(body.date),
          name: body.name,
          paid: body.paid ?? true,
        },
      });
      await this.audit.record({
        actorId,
        action: AUDIT_ACTIONS.ORG_HOLIDAY_CREATE,
        subject: AUDIT_SUBJECTS.ORG,
        subjectId: made.id,
      });
      return made;
    } catch (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
        throw new ConflictException("HOLIDAY_ALREADY_SET");
      }
      throw error;
    }
  }

  async removeHoliday(id: string, actorId: string): Promise<{ done: true }> {
    await this.db.holiday.delete({ where: { id } });
    await this.audit.record({
      actorId,
      action: AUDIT_ACTIONS.ORG_HOLIDAY_DELETE,
      subject: AUDIT_SUBJECTS.ORG,
      subjectId: id,
    });
    return { done: true };
  }

  contracts(employeeId: number): Promise<EmploymentContract[]> {
    return this.db.employmentContract.findMany({
      where: { employeeId },
      orderBy: { startDate: "desc" },
    });
  }

  /**
   * Re-signing is a new contract, not an edit of the old one: the old terms
   * are what a dispute two years from now asks about (KEHOACH 9.3).
   */
  async addContract(
    body: CreateContractDto,
    actorId: string,
  ): Promise<EmploymentContract> {
    const made = await this.db.employmentContract.create({
      data: {
        employeeId: body.employeeId,
        kind: body.kind,
        number: body.number ?? null,
        startDate: new Date(body.startDate),
        endDate: body.endDate ? new Date(body.endDate) : null,
        probationEnd: body.probationEnd ? new Date(body.probationEnd) : null,
        note: body.note ?? null,
      },
    });
    await this.audit.record({
      actorId,
      action: AUDIT_ACTIONS.CONTRACT_CREATE,
      subject: AUDIT_SUBJECTS.EMPLOYEE,
      subjectId: String(body.employeeId),
      meta: { contractId: made.id, kind: body.kind, endDate: body.endDate ?? null },
    });
    return made;
  }

  /** Only one contract stands at a time, so activating one ends the others. */
  async decideContract(
    id: string,
    body: DecideContractDto,
    actorId: string,
  ): Promise<EmploymentContract> {
    const held = await this.db.employmentContract.findUnique({ where: { id } });
    if (!held) {
      throw new NotFoundException("CONTRACT_NOT_FOUND");
    }
    const moved = await this.db.$transaction(async (tx) => {
      if (body.state === "ACTIVE") {
        await tx.employmentContract.updateMany({
          where: { employeeId: held.employeeId, state: "ACTIVE", id: { not: id } },
          data: { state: "ENDED" },
        });
      }
      return tx.employmentContract.update({
        where: { id },
        data: {
          state: body.state,
          note: body.note ?? held.note,
          signedAt: body.state === "ACTIVE" ? (held.signedAt ?? new Date()) : held.signedAt,
        },
      });
    });
    await this.audit.record({
      actorId,
      action: AUDIT_ACTIONS.CONTRACT_DECIDE,
      subject: AUDIT_SUBJECTS.EMPLOYEE,
      subjectId: String(held.employeeId),
      meta: { contractId: id, state: body.state },
    });
    return moved;
  }

  entities(): Promise<LegalEntity[]> {
    return this.db.legalEntity.findMany({ where: { active: true }, orderBy: { code: "asc" } });
  }

  jobTitles(): Promise<JobTitle[]> {
    return this.db.jobTitle.findMany({ where: { active: true }, orderBy: { code: "asc" } });
  }

  /** The whole tree flat, carrying parentId so a caller shapes it once. */
  /** The head count comes back with the tree: an org chart without it answers
   *  where somebody sits and never how many sit there (KEHOACH 9.18).
   */
  async departments(legalEntityId?: string): Promise<DepartmentNode[]> {
    const narrow = legalEntityId ? { legalEntityId } : {};
    const [rows, counts] = await Promise.all([
      this.db.department.findMany({
        where: { active: true, ...narrow },
        orderBy: [{ legalEntityId: "asc" }, { code: "asc" }],
      }),
      this.db.employee.groupBy({
        by: ["departmentId"],
        where: { active: true, departmentId: { not: null }, ...narrow },
        _count: { _all: true },
      }),
    ]);
    const held = new Map(counts.map((one) => [one.departmentId, one._count._all]));
    return rows.map((row) => ({ ...row, headcount: held.get(row.id) ?? 0 }));
  }

  async createDepartment(body: CreateDepartmentDto): Promise<Department> {
    await this.mustExist(body.parentId);
    try {
      return await this.db.department.create({ data: body });
    } catch (error) {
      if (isCode(error, UNIQUE_VIOLATION)) {
        throw new ConflictException("DEPARTMENT_CODE_TAKEN");
      }
      throw error;
    }
  }

  async updateDepartment(id: string, body: UpdateDepartmentDto): Promise<Department> {
    if (body.parentId !== undefined) {
      await this.mustExist(body.parentId);
      await this.mustNotLoop(id, body.parentId);
    }
    return this.db.department.update({ where: { id }, data: body });
  }

  private async mustExist(parentId?: string | null): Promise<void> {
    if (!parentId) {
      return;
    }
    const held = await this.db.department.findUnique({ where: { id: parentId } });
    if (!held) {
      throw new NotFoundException("DEPARTMENT_NOT_FOUND");
    }
  }

  // A cycle is not caught by any constraint, and it hangs every walk of the tree.
  private async mustNotLoop(id: string, parentId: string | null): Promise<void> {
    let at: string | null = parentId;
    while (at) {
      if (at === id) {
        throw new ConflictException("DEPARTMENT_CYCLE");
      }
      const up: { parentId: string | null } | null = await this.db.department.findUnique({
        where: { id: at },
        select: { parentId: true },
      });
      at = up?.parentId ?? null;
    }
  }
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
