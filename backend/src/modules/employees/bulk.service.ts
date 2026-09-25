import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";

import { ScopeService } from "../../common/scope/scope.service.js";
import type { Viewer } from "../../common/scope/viewer.js";
import { PrismaService } from "../../database/prisma.service.js";
import { AUDIT_ACTIONS, AUDIT_SUBJECTS } from "../audit/audit-actions.js";
import { AuditService, type AuditEntry } from "../audit/audit.service.js";
import { UNUSABLE_PASSWORD } from "../auth/password.js";
import { EnrollmentService } from "../enrollment/enrollment.service.js";
import { UsersService } from "../users/users.service.js";
import {
  BULK_MAX,
  type BulkEnrollDto,
  type BulkPlacementDto,
  type BulkSelectionDto,
  type PlacementField,
  type SkipReason,
} from "./dto/employee.dto.js";
import { EmployeesService, repointPending } from "./employees.service.js";

const kTransactionMs = 60_000;
// A pair in one of these holds a face or waits for one; a bulk run never turns ENROLLED into RETAKE (KEHOACH 9.20).
const ON_KIOSK: ReadonlySet<string> = new Set(["ASSIGNED", "ENROLLED", "RETAKE"]);

const COLUMN: Record<PlacementField, string> = {
  jobTitle: "jobTitleId",
  department: "departmentId",
  manager: "managerId",
  legalEntity: "legalEntityId",
};

/** One person a bulk run passes over, and the code that says why (KEHOACH 9.20). */
export interface BulkSkip {
  employeeId: number;
  code: string | null;
  fullName: string | null;
  reason: SkipReason;
}

/** The people a selection names who exist and are in reach, and the ids that are neither. */
export interface Chosen {
  ids: number[];
  missing: BulkSkip[];
}

export interface PlacementChange {
  field: PlacementField;
  from: string | null;
  to: string | null;
}

export interface PlacementRow {
  employeeId: number;
  code: string;
  fullName: string;
  changes: PlacementChange[];
  pendingRequests: number;
}

export interface PlacementPlan {
  applied: boolean;
  rows: PlacementRow[];
  skipped: BulkSkip[];
  requestsMoved: number;
}

export interface LoginRow {
  employeeId: number;
  code: string;
  fullName: string;
  email: string;
  resend: boolean;
}

export interface LoginPlan {
  applied: boolean;
  rows: LoginRow[];
  skipped: BulkSkip[];
}

export interface EnrollRow {
  employeeId: number;
  code: string;
  fullName: string;
  rosterVersion: number | null;
}

export interface EnrollPlan {
  applied: boolean;
  deviceId: string;
  rows: EnrollRow[];
  skipped: BulkSkip[];
  rosterVersion: number;
}

export function skipOf(employeeId: number, person: { code: string; fullName: string } | null, reason: SkipReason): BulkSkip {
  return { employeeId, code: person?.code ?? null, fullName: person?.fullName ?? null, reason };
}

const PLACED = {
  id: true,
  code: true,
  fullName: true,
  active: true,
  legalEntityId: true,
  departmentId: true,
  jobTitleId: true,
  managerId: true,
  legalEntity: { select: { name: true } },
  department: { select: { name: true, legalEntityId: true } },
  jobTitle: { select: { name: true } },
  manager: { select: { fullName: true } },
} as const satisfies Prisma.EmployeeSelect;

type Placed = Prisma.EmployeeGetPayload<{ select: typeof PLACED }>;

interface Target {
  entity: { id: string; name: string } | null;
  department: { id: string; name: string; legalEntityId: string; legalEntity: { name: string } } | null;
  title: { id: string; name: string } | null;
  manager: { id: number; fullName: string } | null;
}

const LOGGABLE = {
  id: true,
  code: true,
  fullName: true,
  active: true,
  leaveDate: true,
  personalEmail: true,
  locale: true,
  login: { select: { id: true, email: true, active: true, passwordHash: true } },
  _count: { select: { reports: { where: { active: true } } } },
} as const satisfies Prisma.EmployeeSelect;

type Loggable = Prisma.EmployeeGetPayload<{ select: typeof LOGGABLE }>;

/** The entity a department brings along when the batch names none of its own. */
function entityOf(target: Target): { id: string; name: string } | null {
  if (target.entity) {
    return target.entity;
  }
  return target.department ? { id: target.department.legalEntityId, name: target.department.legalEntity.name } : null;
}

/** What the batch changes for one person, or why it leaves them alone; the rules of PATCH /employees/:id. */
function placeOne(person: Placed, target: Target, above: ReadonlySet<number>): PlacementChange[] | SkipReason {
  if (!person.active) {
    return "EMPLOYEE_HAS_LEFT";
  }
  const brought = entityOf(target);
  const entityTo = target.entity?.id ?? person.legalEntityId ?? brought?.id ?? null;
  const departmentTo = target.department?.id ?? person.departmentId;
  const departmentEntity = target.department?.legalEntityId ?? person.department?.legalEntityId ?? null;
  const moves = target.department !== null || target.entity !== null;
  if (moves && departmentTo && entityTo && departmentEntity !== entityTo) {
    return "DEPARTMENT_OTHER_ENTITY";
  }
  if (target.manager && above.has(person.id)) {
    return "MANAGER_CYCLE";
  }
  const changes: PlacementChange[] = [];
  if (target.title && person.jobTitleId !== target.title.id) {
    changes.push({ field: "jobTitle", from: person.jobTitle?.name ?? null, to: target.title.name });
  }
  if (target.department && person.departmentId !== target.department.id) {
    changes.push({ field: "department", from: person.department?.name ?? null, to: target.department.name });
  }
  if (target.manager && person.managerId !== target.manager.id) {
    changes.push({ field: "manager", from: person.manager?.fullName ?? null, to: target.manager.fullName });
  }
  if (brought && entityTo !== person.legalEntityId) {
    changes.push({ field: "legalEntity", from: person.legalEntity?.name ?? null, to: brought.name });
  }
  return changes.length > 0 ? changes : "UNCHANGED";
}

function placedData(target: Target): Prisma.EmployeeUncheckedUpdateManyInput {
  const entity = entityOf(target);
  return {
    ...(target.title ? { jobTitleId: target.title.id } : {}),
    ...(target.department ? { departmentId: target.department.id } : {}),
    ...(target.manager ? { managerId: target.manager.id } : {}),
    ...(entity ? { legalEntityId: entity.id } : {}),
  };
}

/** Why POST /employees/:id/login would not open or re-mail this person's login, or null when it would. */
function loginSkip(person: Loggable, taken: ReadonlySet<string>): SkipReason | null {
  if (!person.active) {
    return "EMPLOYEE_HAS_LEFT";
  }
  if (person.leaveDate !== null) {
    return "LEAVING_SCHEDULED";
  }
  if (person.login) {
    if (!person.login.active) {
      return "ACCOUNT_LOCKED";
    }
    return person.login.passwordHash === UNUSABLE_PASSWORD ? null : "LOGIN_IN_USE";
  }
  if (!person.personalEmail) {
    return "NO_EMAIL";
  }
  return taken.has(person.personalEmail) ? "EMAIL_TAKEN" : null;
}

/** Why POST /enrollments would not, or should not in bulk, put this person up on the kiosk. */
function kioskSkip(person: { active: boolean; consents: unknown[]; enrollments: { state: string }[] }): SkipReason | null {
  if (!person.active) {
    return "EMPLOYEE_HAS_LEFT";
  }
  if (person.consents.length === 0) {
    return "CONSENT_MISSING";
  }
  return person.enrollments.some((pair) => ON_KIOSK.has(pair.state)) ? "ALREADY_ON_KIOSK" : null;
}

/**
 * The four things the directory does to many people at once (KEHOACH 9.20). Each previews by default,
 * holds every person to the rules of the single action, and writes in one transaction when asked.
 */
@Injectable()
export class BulkService {
  constructor(
    private readonly db: PrismaService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly employees: EmployeesService,
    private readonly users: UsersService,
    private readonly enrollment: EnrollmentService,
  ) {}

  /** Who a selection names inside this viewer's reach; a filter is read by the directory's own query.
   *  @ctx task | reads only | SELECTION_INVALID unless exactly one of employeeIds and filter is sent
   */
  async resolve(viewer: Viewer, selection: BulkSelectionDto): Promise<Chosen> {
    if ((selection.employeeIds === undefined) === (selection.filter === undefined)) {
      throw new BadRequestException("SELECTION_INVALID");
    }
    if (selection.filter) {
      return { ids: await this.employees.matchingIds(viewer, selection.filter, BULK_MAX), missing: [] };
    }
    const asked = [...new Set(selection.employeeIds)];
    const visible = await this.scope.visibleEmployeeIds(viewer);
    const reach = visible === null ? null : new Set(visible);
    const found = await this.db.employee.findMany({
      where: { id: { in: asked.filter((id) => reach === null || reach.has(id)) } },
      select: { id: true },
    });
    const here = new Set(found.map((one) => one.id));
    return {
      ids: asked.filter((id) => here.has(id)),
      missing: asked.filter((id) => !here.has(id)).map((id) => skipOf(id, null, "EMPLOYEE_NOT_FOUND")),
    };
  }

  /** Who a new job title, department, manager or legal entity would reach and what it changes for each.
   *  apply=true writes it in one transaction; a new manager takes the pending requests along (KEHOACH 9.4).
   */
  async placement(viewer: Viewer, body: BulkPlacementDto, apply: boolean): Promise<PlacementPlan> {
    if (!body.jobTitleId && !body.departmentId && !body.managerId && !body.legalEntityId) {
      throw new BadRequestException("BULK_NOTHING_TO_CHANGE");
    }
    const target = await this.target(body);
    const chosen = await this.resolve(viewer, body);
    const people = await this.db.employee.findMany({
      where: { id: { in: chosen.ids } },
      select: PLACED,
      orderBy: { code: "asc" },
    });
    const above = target.manager ? await this.chainAbove(target.manager.id) : new Set<number>();
    const waiting = target.manager ? await this.pendingOf(chosen.ids) : new Map<number, number>();

    const rows: PlacementRow[] = [];
    const skipped = [...chosen.missing];
    const bossOf = new Map<number, number | null>();
    for (const person of people) {
      const verdict = placeOne(person, target, above);
      if (typeof verdict === "string") {
        skipped.push(skipOf(person.id, person, verdict));
        continue;
      }
      const moves = verdict.some((one) => one.field === "manager");
      if (moves) {
        bossOf.set(person.id, person.managerId);
      }
      rows.push({
        employeeId: person.id,
        code: person.code,
        fullName: person.fullName,
        changes: verdict,
        pendingRequests: moves ? (waiting.get(person.id) ?? 0) : 0,
      });
    }
    const plan: PlacementPlan = {
      applied: false,
      rows,
      skipped,
      requestsMoved: rows.reduce((total, one) => total + one.pendingRequests, 0),
    };
    if (!apply || rows.length === 0) {
      return plan;
    }

    const ids = rows.map((one) => one.employeeId);
    const moved = [...bossOf.keys()];
    const flips = await this.db.$transaction(
      async (tx) => {
        const written = await tx.employee.updateMany({ where: { id: { in: ids }, active: true }, data: placedData(target) });
        if (written.count !== ids.length) {
          throw new ConflictException("SELECTION_CHANGED");
        }
        if (moved.length === 0) {
          return [];
        }
        await this.scope.assertNoManagerCycle(tx, moved);
        await repointPending(tx, moved);
        return this.users.syncManagerRoles([target.manager?.id, ...bossOf.values()], tx);
      },
      { timeout: kTransactionMs, maxWait: kTransactionMs },
    );
    if (moved.length > 0) {
      await this.scope.forgetScopes();
    }
    await this.users.settleRoleFlips(viewer.userId, flips);
    await this.audit.recordMany(
      rows.map((one): AuditEntry => {
        const boss = bossOf.get(one.employeeId);
        return {
          actorId: viewer.userId,
          action: AUDIT_ACTIONS.EMPLOYEE_UPDATE,
          subject: AUDIT_SUBJECTS.EMPLOYEE,
          subjectId: String(one.employeeId),
          // Who approves them is a power, so it keeps both ends (KEHOACH 9.24 rule 4).
          meta: {
            fields: one.changes.map((change) => COLUMN[change.field]).sort(),
            bulk: true,
            ...(boss !== undefined ? { managerId: { from: boss, to: target.manager?.id ?? null } } : {}),
          },
        };
      }),
    );
    return { ...plan, applied: true };
  }

  /** Who would get a login and who a fresh link to one never used, as POST /employees/:id/login decides.
   *  apply=true opens them in one transaction and queues the letters once it commits (KEHOACH 9.4).
   */
  async logins(viewer: Viewer, body: BulkSelectionDto, apply: boolean): Promise<LoginPlan> {
    const chosen = await this.resolve(viewer, body);
    const people = await this.db.employee.findMany({
      where: { id: { in: chosen.ids } },
      select: LOGGABLE,
      orderBy: { code: "asc" },
    });
    const asked = people.flatMap((one) => (!one.login && one.personalEmail ? [one.personalEmail] : []));
    const held = await this.db.user.findMany({ where: { email: { in: asked } }, select: { email: true } });
    const taken = new Set(held.map((one) => one.email));

    const rows: LoginRow[] = [];
    const skipped = [...chosen.missing];
    const opening: { employeeId: number; email: string; locale: string; manages: boolean }[] = [];
    const resending = new Map<number, { userId: string; locale: string }>();
    for (const person of people) {
      const reason = loginSkip(person, taken);
      if (reason) {
        skipped.push(skipOf(person.id, person, reason));
        continue;
      }
      const email = person.login?.email ?? person.personalEmail ?? "";
      rows.push({ employeeId: person.id, code: person.code, fullName: person.fullName, email, resend: person.login !== null });
      if (person.login) {
        resending.set(person.id, { userId: person.login.id, locale: person.locale });
      } else {
        taken.add(email);
        opening.push({ employeeId: person.id, email, locale: person.locale, manages: person._count.reports > 0 });
      }
    }
    if (!apply || rows.length === 0) {
      return { applied: false, rows, skipped };
    }

    const ids = rows.map((one) => one.employeeId);
    const staged = await this.db.$transaction(
      async (tx) => {
        // Held for the insert: somebody offboarded after the read above opens nothing.
        const standing = await tx.$queryRaw<{ id: number }[]>`
          SELECT "id" FROM "Employee"
           WHERE "id" = ANY(${ids}::int[]) AND "active" AND "leaveDate" IS NULL
             FOR SHARE
        `;
        if (standing.length !== ids.length) {
          throw new ConflictException("SELECTION_CHANGED");
        }
        return this.users.stageSetups(tx, opening, [...resending.values()]);
      },
      { timeout: kTransactionMs, maxWait: kTransactionMs },
    );
    await this.users.mailSetups(staged.jobs);
    const lost = rows.filter((one) => !one.resend && !staged.opened.has(one.employeeId));
    const done = rows.filter((one) => one.resend || staged.opened.has(one.employeeId));
    await this.audit.recordMany(
      done.map((one): AuditEntry => {
        const resent = resending.get(one.employeeId);
        return resent
          ? {
              actorId: viewer.userId,
              action: AUDIT_ACTIONS.USER_INVITE,
              subject: AUDIT_SUBJECTS.USER,
              subjectId: resent.userId,
            }
          : {
              actorId: viewer.userId,
              action: AUDIT_ACTIONS.USER_CREATE,
              subject: AUDIT_SUBJECTS.USER,
              subjectId: staged.opened.get(one.employeeId) ?? "",
              meta: { employeeId: one.employeeId },
            };
      }),
    );
    return { applied: true, rows: done, skipped: [...skipped, ...lost.map((one) => skipOf(one.employeeId, one, "EMAIL_TAKEN"))] };
  }

  /** Who would be put up for capture on one kiosk and who is passed over; apply=true moves the kiosk's
   *  roster on once for the batch and sends each person's ASSIGN after the commit (KEHOACH 7.5).
   */
  async enrollments(viewer: Viewer, body: BulkEnrollDto, apply: boolean): Promise<EnrollPlan> {
    const device = await this.db.device.findFirst({
      where: { id: body.deviceId, status: "APPROVED" },
      select: { id: true, rosterVersion: true },
    });
    if (!device) {
      throw new NotFoundException("DEVICE_NOT_FOUND");
    }
    const chosen = await this.resolve(viewer, body);
    const people = await this.db.employee.findMany({
      where: { id: { in: chosen.ids } },
      select: {
        id: true,
        code: true,
        fullName: true,
        active: true,
        consents: { where: { state: "GRANTED" }, select: { id: true }, take: 1 },
        enrollments: { where: { deviceId: device.id }, select: { state: true } },
      },
      orderBy: { code: "asc" },
    });
    const rows: EnrollRow[] = [];
    const skipped = [...chosen.missing];
    for (const person of people) {
      const reason = kioskSkip(person);
      if (reason) {
        skipped.push(skipOf(person.id, person, reason));
        continue;
      }
      rows.push({ employeeId: person.id, code: person.code, fullName: person.fullName, rosterVersion: null });
    }
    if (!apply || rows.length === 0) {
      return { applied: false, deviceId: device.id, rows, skipped, rosterVersion: device.rosterVersion };
    }

    const sent = await this.enrollment.assignMany(
      device.id,
      rows.map((one) => ({ id: one.employeeId, code: one.code, fullName: one.fullName })),
    );
    const done = rows.flatMap((one) => {
      const version = sent.versions.get(one.employeeId);
      return version === undefined ? [] : [{ ...one, rosterVersion: version }];
    });
    const raced = rows
      .filter((one) => !sent.versions.has(one.employeeId))
      .map((one) => skipOf(one.employeeId, one, "ALREADY_ON_KIOSK"));
    await this.audit.recordMany(
      done.map((one) => ({
        actorId: viewer.userId,
        action: AUDIT_ACTIONS.ENROLLMENT_ASSIGN,
        subject: AUDIT_SUBJECTS.EMPLOYEE,
        subjectId: String(one.employeeId),
        meta: { deviceId: device.id, rosterVersion: one.rosterVersion },
      })),
    );
    return { applied: true, deviceId: device.id, rows: done, skipped: [...skipped, ...raced], rosterVersion: sent.rosterVersion };
  }

  /** The catalogue rows a placement names, each checked the way PATCH /employees/:id checks it. */
  private async target(body: BulkPlacementDto): Promise<Target> {
    const [entity, department, title, manager] = await Promise.all([
      body.legalEntityId
        ? this.db.legalEntity.findUnique({ where: { id: body.legalEntityId }, select: { id: true, name: true, active: true } })
        : null,
      body.departmentId
        ? this.db.department.findUnique({
            where: { id: body.departmentId },
            select: { id: true, name: true, active: true, legalEntityId: true, legalEntity: { select: { name: true } } },
          })
        : null,
      body.jobTitleId
        ? this.db.jobTitle.findUnique({ where: { id: body.jobTitleId }, select: { id: true, name: true, active: true } })
        : null,
      body.managerId
        ? this.db.employee.findUnique({
            where: { id: body.managerId },
            select: { id: true, fullName: true, active: true, leaveDate: true },
          })
        : null,
    ]);
    if (body.legalEntityId && !entity?.active) {
      throw new NotFoundException("LEGAL_ENTITY_NOT_FOUND");
    }
    if (body.departmentId && !department?.active) {
      throw new NotFoundException("DEPARTMENT_NOT_FOUND");
    }
    if (body.jobTitleId && !title?.active) {
      throw new NotFoundException("JOB_TITLE_NOT_FOUND");
    }
    if (body.managerId && !manager) {
      throw new NotFoundException("MANAGER_NOT_FOUND");
    }
    if (manager && (!manager.active || manager.leaveDate !== null)) {
      throw new ConflictException("MANAGER_HAS_LEFT");
    }
    if (entity && department && department.legalEntityId !== entity.id) {
      throw new BadRequestException("DEPARTMENT_OTHER_ENTITY");
    }
    return { entity, department, title, manager };
  }

  // The manager and everyone above them: hanging one of these under the manager closes a loop.
  private async chainAbove(managerId: number): Promise<Set<number>> {
    const rows = await this.db.$queryRaw<{ id: number }[]>`
      WITH RECURSIVE up AS (
        SELECT "id", "managerId" FROM "Employee" WHERE "id" = ${managerId}
        UNION
        SELECT e."id", e."managerId" FROM "Employee" e JOIN up u ON e."id" = u."managerId"
      )
      SELECT "id" FROM up
    `;
    return new Set(rows.map((one) => one.id));
  }

  private async pendingOf(employeeIds: number[]): Promise<Map<number, number>> {
    const waiting = await this.db.request.groupBy({
      by: ["employeeId"],
      where: { employeeId: { in: employeeIds }, state: "PENDING" },
      _count: { _all: true },
    });
    return new Map(waiting.map((one) => [one.employeeId, one._count._all]));
  }
}
