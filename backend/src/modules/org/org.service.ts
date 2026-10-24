import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type {
  Department,
  EmploymentContract,
  Holiday,
  JobTitle,
  LegalEntity,
  Prisma,
} from "@prisma/client";

import { ScopeService } from "../../common/scope/scope.service.js";
import { refuseOwn, type Viewer } from "../../common/scope/viewer.js";
import type { Env } from "../../config/env.schema.js";
import { isPrismaCode, PrismaService, RECORD_NOT_FOUND, UNIQUE_VIOLATION } from "../../database/prisma.service.js";
import { AUDIT_ACTIONS, AUDIT_SUBJECTS } from "../audit/audit-actions.js";
import { AuditService, trail } from "../audit/audit.service.js";
import { NoticeItemsService } from "../notifications/notice-items.service.js";
import { ContractsSweep } from "../notifications/sweeps/contracts.sweep.js";
import { ProbationSweep } from "../notifications/sweeps/probation.sweep.js";
import { asDay, localDay } from "../timesheet/local-day.js";
import { TimesheetService } from "../timesheet/timesheet.service.js";
import { UsersService } from "../users/users.service.js";
import type {
  CreateContractDto,
  CreateDepartmentDto,
  CreateHolidayDto,
  CreateJobTitleDto,
  CreateLegalEntityDto,
  DecideContractDto,
  ListDepartmentsDto,
  ReorgDto,
  UpdateDepartmentDto,
  UpdateHolidayDto,
  UpdateJobTitleDto,
  UpdateLegalEntityDto,
} from "./dto/org.dto.js";

const DEPARTMENT_TREE_LOCK_KEY = 77;

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

export interface PersonRef {
  id: number;
  code: string;
  fullName: string;
}

/** A department plus the people filed directly under it, not its subtree. */
export interface DepartmentNode extends Department {
  headcount: number;
  head: PersonRef | null;
}

/** A job title and how many people currently hold it. */
export type JobTitleRow = JobTitle & { holders: number };

/** An entity and how many people are filed under it now. */
export type LegalEntityRow = LegalEntity & { employees: number };

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
    private readonly users: UsersService,
    private readonly items: NoticeItemsService,
    private readonly contractsDue: ContractsSweep,
    private readonly probationDue: ProbationSweep,
    private readonly config: ConfigService<Env, true>,
    private readonly timesheet: TimesheetService,
  ) {}

  /**
   * What a reorganisation would do, and then, on request, doing it. The two
   * share one code path so the preview cannot describe a different move from
   * the one that lands (KEHOACH 9.18 item 7).
   */
  async reorg(viewer: Viewer, body: ReorgDto, apply: boolean): Promise<ReorgPlan> {
    const chosen = body.employeeCodes?.length ? body.employeeCodes : null;
    // Nothing to narrow by would move the whole company, one typo away from an empty department id.
    if (!chosen && !body.fromDepartmentId) {
      throw new BadRequestException("REORG_NEEDS_A_SELECTION");
    }
    if (!body.toDepartmentId && !body.toManagerCode) {
      throw new BadRequestException("REORG_NEEDS_A_DESTINATION");
    }
    const reached = await this.reached(viewer);
    const people = await this.db.employee.findMany({
      where: {
        ...reached,
        active: true,
        ...(chosen ? { code: { in: chosen } } : {}),
        ...(body.fromDepartmentId ? { departmentId: body.fromDepartmentId } : {}),
      },
      select: {
        id: true,
        code: true,
        fullName: true,
        legalEntityId: true,
        departmentId: true,
        department: { select: { code: true } },
        managerId: true,
        manager: { select: { code: true } },
      },
      orderBy: { code: "asc" },
    });
    if (people.length === 0) {
      throw new NotFoundException("REORG_MOVES_NOBODY");
    }

    const toDepartment = body.toDepartmentId
      ? await this.db.department.findFirst({
          where: { id: body.toDepartmentId, ...ScopeService.entityWhere(viewer, false) },
          select: { id: true, code: true, legalEntityId: true, active: true },
        })
      : null;
    if (body.toDepartmentId && !toDepartment?.active) {
      throw new NotFoundException("DEPARTMENT_NOT_FOUND");
    }
    // The same refusals as the single-row write: a department files only its own entity's people (KEHOACH 9.3).
    if (toDepartment && people.some((one) => one.legalEntityId !== toDepartment.legalEntityId)) {
      throw new BadRequestException("DEPARTMENT_OTHER_ENTITY");
    }
    const toManager = body.toManagerCode
      ? await this.db.employee.findFirst({
          where: { ...reached, code: body.toManagerCode },
          select: { id: true, code: true, active: true, leaveDate: true },
        })
      : null;
    if (body.toManagerCode && !toManager) {
      throw new NotFoundException("EMPLOYEE_NOT_FOUND");
    }
    if (toManager && (!toManager.active || toManager.leaveDate !== null)) {
      throw new ConflictException("MANAGER_HAS_LEFT");
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

    const flips = await this.db.$transaction(async (tx) => {
      await tx.employee.updateMany({
        where: { id: { in: ids } },
        data: {
          ...(toDepartment ? { departmentId: toDepartment.id } : {}),
          ...(toManager ? { managerId: toManager.id } : {}),
        },
      });
      await this.scope.assertNoManagerCycle(tx, ids);
      if (!toManager) {
        return [];
      }
      // Left with its old approver, a request reaches somebody who cannot see the person, so nobody answers it.
      await tx.request.updateMany({
        where: { employeeId: { in: ids }, state: "PENDING" },
        data: { approverId: toManager.id },
      });
      return this.users.syncManagerRoles([toManager.id, ...people.map((one) => one.managerId)], tx);
    });
    await this.scope.forgetScopes();
    await this.users.settleRoleFlips(viewer.userId, flips);
    if (toManager) {
      await this.items.regroupPeople("REQUESTS", ids);
    }
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.ORG_REORG,
      subject: AUDIT_SUBJECTS.ORG,
      subjectId: toDepartment?.code ?? "selection",
      meta: { moved: ids.length, toDepartment: toDepartment?.code, toManager: toManager?.code },
    });
    if (toManager) {
      // Who approves them is a power, so each person moved keeps both ends (KEHOACH 9.24 rule 4).
      await this.audit.recordMany(
        people
          .filter((one) => one.managerId !== toManager.id)
          .map((one) => ({
            actorId: viewer.userId,
            action: AUDIT_ACTIONS.EMPLOYEE_UPDATE,
            subject: AUDIT_SUBJECTS.EMPLOYEE,
            subjectId: String(one.id),
            meta: {
              fields: toDepartment && one.departmentId !== toDepartment.id ? ["departmentId", "managerId"] : ["managerId"],
              reorg: true,
              managerId: { from: one.managerId, to: toManager.id },
            },
          })),
      );
    }
    return { ...plan, applied: true };
  }

  holidays(viewer: Viewer, year?: number): Promise<Holiday[]> {
    const wanted = year ?? Number(localDay(new Date(), this.config.get("APP_TIMEZONE", { infer: true })).slice(0, 4));
    return this.db.holiday.findMany({
      where: {
        date: { gte: new Date(Date.UTC(wanted, 0, 1)), lte: new Date(Date.UTC(wanted + 1, 0, 0)) },
        ...ScopeService.entityWhere(viewer, true),
      },
      orderBy: { date: "asc" },
    });
  }

  /**
   * Without a row here a public holiday reads as absent and is docked from
   * pay, because the day build has nothing else to tell them apart.
   */
  async addHoliday(body: CreateHolidayDto, viewer: Viewer): Promise<Holiday> {
    const legalEntityId = body.legalEntityId ?? null;
    if (legalEntityId === null) {
      ScopeService.mustWriteGroup(viewer);
    } else if (!ScopeService.reachesEntity(viewer, legalEntityId)) {
      throw new NotFoundException("LEGAL_ENTITY_NOT_FOUND");
    }
    try {
      const made = await this.db.holiday.create({
        data: {
          legalEntityId,
          date: new Date(body.date),
          name: body.name,
          paid: body.paid ?? true,
        },
      });
      await this.audit.record({
        actorId: viewer.userId,
        action: AUDIT_ACTIONS.ORG_HOLIDAY_CREATE,
        subject: AUDIT_SUBJECTS.ORG,
        subjectId: made.id,
      });
      await this.rebuildIfPast(made);
      return made;
    } catch (error) {
      if (isPrismaCode(error, UNIQUE_VIOLATION)) {
        throw new ConflictException("HOLIDAY_ALREADY_SET");
      }
      throw error;
    }
  }

  async updateHoliday(id: string, body: UpdateHolidayDto, viewer: Viewer): Promise<Holiday> {
    const held = await this.writableHoliday(id, viewer);
    const saved = await this.db.holiday.update({ where: { id }, data: body }).catch((error: unknown) => {
      throw isPrismaCode(error, RECORD_NOT_FOUND) ? new NotFoundException("HOLIDAY_NOT_FOUND") : error;
    });
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.ORG_HOLIDAY_UPDATE,
      subject: AUDIT_SUBJECTS.ORG,
      subjectId: id,
      meta: trail(held, body),
    });
    if (body.paid !== undefined && body.paid !== held.paid) {
      await this.rebuildIfPast(saved);
    }
    return saved;
  }

  async removeHoliday(id: string, viewer: Viewer): Promise<{ done: true }> {
    const held = await this.writableHoliday(id, viewer);
    await this.db.holiday.delete({ where: { id } }).catch((error: unknown) => {
      throw isPrismaCode(error, RECORD_NOT_FOUND) ? new NotFoundException("HOLIDAY_NOT_FOUND") : error;
    });
    await this.rebuildIfPast(held);
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.ORG_HOLIDAY_DELETE,
      subject: AUDIT_SUBJECTS.ORG,
      subjectId: id,
    });
    return { done: true };
  }

  // A finished day's rows carry its calendar, and the pay run reads those rows rather than the holidays (KEHOACH 9.8).
  private async rebuildIfPast(holiday: Pick<Holiday, "date" | "legalEntityId">): Promise<void> {
    const day = asDay(holiday.date);
    if (day < this.timesheet.today()) {
      await this.timesheet.scheduleBuild(day, day, holiday.legalEntityId === null ? null : [holiday.legalEntityId]);
    }
  }

  private async writableHoliday(id: string, viewer: Viewer): Promise<Holiday> {
    const held = await this.db.holiday.findUnique({ where: { id } });
    if (!held || !ScopeService.reachesEntity(viewer, held.legalEntityId)) {
      throw new NotFoundException("HOLIDAY_NOT_FOUND");
    }
    if (held.legalEntityId === null) {
      ScopeService.mustWriteGroup(viewer);
    }
    return held;
  }

  async contracts(viewer: Viewer, employeeId: number): Promise<EmploymentContract[]> {
    const visible = await this.scope.visibleEmployeeIds(viewer);
    if (!(await this.scope.reaches(viewer, visible, employeeId))) {
      throw new NotFoundException("EMPLOYEE_NOT_FOUND");
    }
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
    viewer: Viewer,
  ): Promise<EmploymentContract> {
    refuseOwn(viewer, body.employeeId);
    const signer = await this.db.employee.count({ where: { AND: [{ id: body.employeeId }, await this.reached(viewer)] } });
    if (signer === 0) {
      throw new NotFoundException("EMPLOYEE_NOT_FOUND");
    }
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
      actorId: viewer.userId,
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
    viewer: Viewer,
  ): Promise<EmploymentContract> {
    const visible = await this.scope.visibleEmployeeIds(viewer);
    const held = await this.db.employmentContract.findFirst({ where: { id, ...ScopeService.ownedWhere(viewer, visible) } });
    if (!held) {
      throw new NotFoundException("CONTRACT_NOT_FOUND");
    }
    refuseOwn(viewer, held.employeeId);
    const moved = await this.db.$transaction(async (tx) => {
      // Moves of one person's contracts queue here, so a second activation ends the first.
      await tx.$executeRaw`SELECT 1 FROM "Employee" WHERE "id" = ${held.employeeId} FOR NO KEY UPDATE`;
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
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.CONTRACT_DECIDE,
      subject: AUDIT_SUBJECTS.EMPLOYEE,
      subjectId: String(held.employeeId),
      meta: { contractId: id, state: body.state },
    });
    await this.contractsDue.closeVanished(held.employeeId, viewer.userId);
    await this.probationDue.closeVanished(held.employeeId, viewer.userId);
    return moved;
  }

  async entities(viewer: Viewer, all = false): Promise<LegalEntityRow[]> {
    const reached = await this.reached(viewer);
    const [rows, counts] = await Promise.all([
      this.db.legalEntity.findMany({
        where: { ...(all ? {} : { active: true }), ...(viewer.entityIds === null ? {} : { id: { in: viewer.entityIds } }) },
        orderBy: { code: "asc" },
      }),
      this.db.employee.groupBy({
        by: ["legalEntityId"],
        where: { ...reached, active: true },
        _count: { _all: true },
      }),
    ]);
    const held = new Map(counts.map((one) => [one.legalEntityId, one._count._all]));
    return rows.map((row) => ({ ...row, employees: held.get(row.id) ?? 0 }));
  }

  async createEntity(body: CreateLegalEntityDto, actorId: string): Promise<LegalEntity> {
    const made = await this.db.legalEntity
      .create({ data: { code: body.code, name: body.name, taxCode: body.taxCode ?? null, address: body.address ?? null } })
      .catch((error: unknown) => {
        throw isPrismaCode(error, UNIQUE_VIOLATION) ? new ConflictException("ENTITY_CODE_TAKEN") : error;
      });
    await this.audit.record({
      actorId,
      action: AUDIT_ACTIONS.LEGAL_ENTITY_CREATE,
      subject: AUDIT_SUBJECTS.LEGAL_ENTITY,
      subjectId: made.id,
      meta: { code: made.code },
    });
    return made;
  }

  /** Retiring an entity that still files people, departments or a pay period
   *  would orphan that work, so it is refused with a code (KEHOACH 9.3).
   */
  async updateEntity(id: string, body: UpdateLegalEntityDto, actorId: string): Promise<LegalEntity> {
    const held = await this.db.legalEntity.findUnique({ where: { id } });
    if (!held) {
      throw new NotFoundException("LEGAL_ENTITY_NOT_FOUND");
    }
    if (body.active === false && held.active) {
      const [people, units, periods] = await Promise.all([
        this.db.employee.count({ where: { legalEntityId: id, active: true } }),
        this.db.department.count({ where: { legalEntityId: id, active: true } }),
        this.db.payrollPeriod.count({ where: { legalEntityId: id, state: { not: "PAID" } } }),
      ]);
      if (people + units + periods > 0) {
        throw new ConflictException("ENTITY_IN_USE");
      }
    }
    const saved = await this.db.legalEntity.update({ where: { id }, data: body }).catch((error: unknown) => {
      if (isPrismaCode(error, UNIQUE_VIOLATION)) {
        throw new ConflictException("ENTITY_CODE_TAKEN");
      }
      throw isPrismaCode(error, RECORD_NOT_FOUND) ? new NotFoundException("LEGAL_ENTITY_NOT_FOUND") : error;
    });
    await this.audit.record({
      actorId,
      action: AUDIT_ACTIONS.LEGAL_ENTITY_UPDATE,
      subject: AUDIT_SUBJECTS.LEGAL_ENTITY,
      subjectId: id,
      meta: trail(held, body),
    });
    return saved;
  }

  async jobTitles(viewer: Viewer, all = false): Promise<JobTitleRow[]> {
    const reached = await this.reached(viewer);
    const [rows, counts] = await Promise.all([
      this.db.jobTitle.findMany({ where: all ? {} : { active: true }, orderBy: { code: "asc" } }),
      this.db.employee.groupBy({
        by: ["jobTitleId"],
        where: { ...reached, active: true, jobTitleId: { not: null } },
        _count: { _all: true },
      }),
    ]);
    const held = new Map(counts.map((one) => [one.jobTitleId, one._count._all]));
    return rows.map((row) => ({ ...row, holders: held.get(row.id) ?? 0 }));
  }

  async createJobTitle(body: CreateJobTitleDto, actorId: string): Promise<JobTitle> {
    const made = await this.db.jobTitle
      .create({
        data: {
          code: body.code,
          name: body.name,
          grade: body.grade ?? null,
          laborCategory: body.laborCategory ?? null,
        },
      })
      .catch((error: unknown) => {
        throw isPrismaCode(error, UNIQUE_VIOLATION) ? new ConflictException("JOB_TITLE_CODE_TAKEN") : error;
      });
    await this.audit.record({
      actorId,
      action: AUDIT_ACTIONS.JOB_TITLE_CREATE,
      subject: AUDIT_SUBJECTS.JOB_TITLE,
      subjectId: made.id,
      meta: { code: made.code },
    });
    return made;
  }

  /** Retiring hides a title from pickers; the people holding it keep it. */
  async updateJobTitle(id: string, body: UpdateJobTitleDto, actorId: string): Promise<JobTitle> {
    const held = await this.db.jobTitle.findUnique({ where: { id } });
    if (!held) {
      throw new NotFoundException("JOB_TITLE_NOT_FOUND");
    }
    const saved = await this.db.jobTitle.update({ where: { id }, data: body }).catch((error: unknown) => {
      if (isPrismaCode(error, UNIQUE_VIOLATION)) {
        throw new ConflictException("JOB_TITLE_CODE_TAKEN");
      }
      throw isPrismaCode(error, RECORD_NOT_FOUND) ? new NotFoundException("JOB_TITLE_NOT_FOUND") : error;
    });
    await this.audit.record({
      actorId,
      action: AUDIT_ACTIONS.JOB_TITLE_UPDATE,
      subject: AUDIT_SUBJECTS.JOB_TITLE,
      subjectId: id,
      meta: trail(held, body),
    });
    return saved;
  }

  /** The whole tree flat, carrying parentId so a caller shapes it once. The
   *  head count comes back with it: an org chart without it answers where
   *  somebody sits and never how many sit there (KEHOACH 9.18).
   */
  async departments(viewer: Viewer, query: ListDepartmentsDto): Promise<DepartmentNode[]> {
    const narrow = query.legalEntityId ? { legalEntityId: query.legalEntityId } : {};
    const reach = ScopeService.entityWhere(viewer, false);
    const [rows, counts] = await Promise.all([
      this.db.department.findMany({
        where: { AND: [{ ...(query.all ? {} : { active: true }), ...narrow }, reach] },
        orderBy: [{ legalEntityId: "asc" }, { code: "asc" }],
      }),
      this.db.employee.groupBy({
        by: ["departmentId"],
        where: { AND: [{ active: true, departmentId: { not: null }, ...narrow }, reach] },
        _count: { _all: true },
      }),
    ]);
    const headIds = [...new Set(rows.flatMap((row) => (row.headId === null ? [] : [row.headId])))];
    const heads = headIds.length
      ? await this.db.employee.findMany({
          where: { id: { in: headIds } },
          select: { id: true, code: true, fullName: true },
        })
      : [];
    const headOf = new Map(heads.map((one) => [one.id, one]));
    const held = new Map(counts.map((one) => [one.departmentId, one._count._all]));
    return rows.map((row) => ({
      ...row,
      headcount: held.get(row.id) ?? 0,
      head: row.headId === null ? null : (headOf.get(row.headId) ?? null),
    }));
  }

  async createDepartment(body: CreateDepartmentDto, viewer: Viewer): Promise<Department> {
    if (!ScopeService.reachesEntity(viewer, body.legalEntityId)) {
      throw new NotFoundException("LEGAL_ENTITY_NOT_FOUND");
    }
    await this.mustBeParent(viewer, body.parentId, body.legalEntityId);
    await this.mustBeHead(viewer, body.headId);
    const made = await this.db.department.create({ data: body }).catch((error: unknown) => {
      throw isPrismaCode(error, UNIQUE_VIOLATION) ? new ConflictException("DEPARTMENT_CODE_TAKEN") : error;
    });
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.DEPARTMENT_CREATE,
      subject: AUDIT_SUBJECTS.DEPARTMENT,
      subjectId: made.id,
      meta: { code: made.code, parentId: made.parentId },
    });
    return made;
  }

  /** Rename, move, change head or cost centre, retire or restore. A retired
   *  department still holding people or live children is refused (KEHOACH 9.3).
   */
  async updateDepartment(id: string, body: UpdateDepartmentDto, viewer: Viewer): Promise<Department> {
    const held = await this.db.department.findUnique({ where: { id } });
    if (!held || !ScopeService.reachesEntity(viewer, held.legalEntityId)) {
      throw new NotFoundException("DEPARTMENT_NOT_FOUND");
    }
    const moves = body.parentId !== undefined && body.parentId !== held.parentId;
    if (moves) {
      await this.mustBeParent(viewer, body.parentId, held.legalEntityId);
    }
    await this.mustBeHead(viewer, body.headId);
    if (body.active === false && held.active) {
      const [people, children] = await Promise.all([
        this.db.employee.count({ where: { departmentId: id, active: true } }),
        this.db.department.count({ where: { parentId: id, active: true } }),
      ]);
      if (people + children > 0) {
        throw new ConflictException("DEPARTMENT_IN_USE");
      }
    }
    const saved = await this.db
      .$transaction(async (tx) => {
        if (moves) {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${DEPARTMENT_TREE_LOCK_KEY}::int, 0)`;
          await this.mustNotLoop(tx, id, body.parentId ?? null);
        }
        return tx.department.update({ where: { id }, data: body });
      })
      .catch((error: unknown) => {
        if (isPrismaCode(error, UNIQUE_VIOLATION)) {
          throw new ConflictException("DEPARTMENT_CODE_TAKEN");
        }
        throw isPrismaCode(error, RECORD_NOT_FOUND) ? new NotFoundException("DEPARTMENT_NOT_FOUND") : error;
      });
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.DEPARTMENT_UPDATE,
      subject: AUDIT_SUBJECTS.DEPARTMENT,
      subjectId: id,
      meta: trail(held, body),
    });
    return saved;
  }

  // A tree that crosses entities files one branch's people under the wrong insurance return.
  private async mustBeParent(viewer: Viewer, parentId: string | null | undefined, legalEntityId: string): Promise<void> {
    if (!parentId) {
      return;
    }
    const held = await this.db.department.findUnique({ where: { id: parentId } });
    if (!held || !ScopeService.reachesEntity(viewer, held.legalEntityId)) {
      throw new NotFoundException("DEPARTMENT_NOT_FOUND");
    }
    if (held.legalEntityId !== legalEntityId) {
      throw new ConflictException("DEPARTMENT_ENTITY_MISMATCH");
    }
  }

  private async mustBeHead(viewer: Viewer, headId: number | null | undefined): Promise<void> {
    if (headId === null || headId === undefined) {
      return;
    }
    const held = await this.db.employee.count({ where: { AND: [{ id: headId, active: true }, await this.reached(viewer)] } });
    if (held === 0) {
      throw new NotFoundException("EMPLOYEE_NOT_FOUND");
    }
  }

  private async reached(viewer: Viewer): Promise<Prisma.EmployeeWhereInput> {
    return ScopeService.peopleWhere(viewer, await this.scope.visibleEmployeeIds(viewer));
  }

  // A cycle is not caught by any constraint, and it hangs every walk of the tree; one already stored is refused, not walked.
  private async mustNotLoop(tx: Prisma.TransactionClient, id: string, parentId: string | null): Promise<void> {
    const passed = new Set<string>();
    let at: string | null = parentId;
    while (at) {
      if (at === id || passed.has(at)) {
        throw new ConflictException("DEPARTMENT_CYCLE");
      }
      passed.add(at);
      const up: { parentId: string | null } | null = await tx.department.findUnique({
        where: { id: at },
        select: { parentId: true },
      });
      at = up?.parentId ?? null;
    }
  }
}
