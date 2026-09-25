import { ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type {
  ChecklistKind,
  ChecklistTask,
  ChecklistTemplateItem,
  Prisma,
  TaskOwner,
} from "@prisma/client";

import type { Page } from "../../common/dto/pagination.dto.js";
import { COUNT_CEILING, countedTo } from "../../common/dto/cursor.dto.js";
import { ScopeService } from "../../common/scope/scope.service.js";
import type { Viewer } from "../../common/scope/viewer.js";
import type { Env } from "../../config/env.schema.js";
import { PrismaService } from "../../database/prisma.service.js";
import { AUDIT_ACTIONS, AUDIT_SUBJECTS } from "../audit/audit-actions.js";
import { AuditService } from "../audit/audit.service.js";
import { departmentSubtree } from "../../common/scope/department-subtree.js";
import { dayAsDate, localDay } from "../timesheet/local-day.js";
import type {
  CreateTemplateDto,
  FinishTaskDto,
  ListOpenTasksDto,
  ListTemplatesDto,
  OpenCountsDto,
  StartRunDto,
  TemplateItemDto,
  UpdateTemplateDto,
} from "./dto/onboarding.dto.js";

const UNIQUE_VIOLATION = "P2002";
const FOREIGN_KEY_VIOLATION = "P2003";

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

const TEMPLATE_VIEW = {
  items: { orderBy: { ordinal: "asc" } },
  jobTitle: { select: { id: true, code: true, name: true } },
  department: { select: { id: true, code: true, name: true } },
} satisfies Prisma.ChecklistTemplateInclude;

export type TemplateRow = Prisma.ChecklistTemplateGetPayload<{ include: typeof TEMPLATE_VIEW }>;

/** A finished task with the person it belongs to, so their own screens hear of it. */
export type FinishedTask = ChecklistTask & { employeeId: number };

function itemsOf(items: TemplateItemDto[]): Prisma.ChecklistTemplateItemCreateWithoutTemplateInput[] {
  return items.map((item, at) => ({ ordinal: at + 1, title: item.title, owner: item.owner, dueDays: item.dueDays }));
}

export type RunWithTasks = Prisma.ChecklistRunGetPayload<{
  include: { tasks: true; template: { select: { name: true } } };
}>;

const OPEN_TASK = {
  run: { select: { kind: true, employee: { select: { id: true, code: true, fullName: true } } } },
} as const;

export type OpenTask = Prisma.ChecklistTaskGetPayload<{ include: typeof OPEN_TASK }>;

/** What is still open, how much of it is late, and who each part waits on. */
export interface OpenCounts {
  open: number;
  overdue: number;
  owners: Record<TaskOwner, number>;
}

const kMsPerDay = 86_400_000;

/** What planting a run needs off the record: who they are and who owns the
 *  tasks written for a manager.
 */
export interface Hire {
  id: number;
  jobTitleId: string | null;
  departmentId: string | null;
  managerId: number | null;
}

@Injectable()
export class OnboardingService {
  constructor(
    private readonly db: PrismaService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  // Due dates are calendar days, so a task is late once its day is earlier than the company's today.
  private todayDate(): Date {
    return dayAsDate(localDay(new Date(), this.config.get("APP_TIMEZONE", { infer: true })));
  }

  templates(query: ListTemplatesDto): Promise<TemplateRow[]> {
    return this.db.checklistTemplate.findMany({
      where: { ...(query.all ? {} : { active: true }), ...(query.kind ? { kind: query.kind } : {}) },
      include: TEMPLATE_VIEW,
      orderBy: [{ active: "desc" }, { name: "asc" }],
    });
  }

  async createTemplate(viewer: Viewer, body: CreateTemplateDto): Promise<TemplateRow> {
    const made = await this.db.checklistTemplate
      .create({
        data: {
          kind: body.kind,
          name: body.name,
          jobTitleId: body.jobTitleId ?? null,
          departmentId: body.departmentId ?? null,
          items: { create: itemsOf(body.items) },
        },
        include: TEMPLATE_VIEW,
      })
      .catch((error: unknown) => {
        throw isCode(error, FOREIGN_KEY_VIOLATION) ? new NotFoundException("AUDIENCE_NOT_FOUND") : error;
      });
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.CHECKLIST_TEMPLATE_CREATE,
      subject: AUDIT_SUBJECTS.CHECKLIST_TEMPLATE,
      subjectId: made.id,
      meta: { kind: made.kind, items: made.items.length },
    });
    return made;
  }

  /** Items sent replace the whole list; runs already started keep the copy they took (KEHOACH 9.3). */
  async updateTemplate(viewer: Viewer, id: string, body: UpdateTemplateDto): Promise<TemplateRow> {
    const held = await this.db.checklistTemplate.findUnique({ where: { id } });
    if (!held) {
      throw new NotFoundException("TEMPLATE_NOT_FOUND");
    }
    const { items, ...fields } = body;
    const saved = await this.db
      .$transaction(async (tx) => {
        if (items) {
          await tx.checklistTemplateItem.deleteMany({ where: { templateId: id } });
        }
        return tx.checklistTemplate.update({
          where: { id },
          data: { ...fields, ...(items ? { items: { create: itemsOf(items) } } : {}) },
          include: TEMPLATE_VIEW,
        });
      })
      .catch((error: unknown) => {
        throw isCode(error, FOREIGN_KEY_VIOLATION) ? new NotFoundException("AUDIENCE_NOT_FOUND") : error;
      });
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.CHECKLIST_TEMPLATE_UPDATE,
      subject: AUDIT_SUBJECTS.CHECKLIST_TEMPLATE,
      subjectId: id,
      meta: { fields: Object.keys(body), ...(fields.active === undefined ? {} : { active: fields.active }) },
    });
    return saved;
  }

  /**
   * The most specific template wins: one written for this job title in this
   * department beats one written for either alone, and a plain one is the
   * fallback. Nothing matching is not a silent no-op.
   */
  async pickTemplate(kind: ChecklistKind, jobTitleId: string | null, departmentId: string | null) {
    const best = await this.findTemplate(kind, jobTitleId, departmentId);
    if (!best) {
      throw new NotFoundException("NO_CHECKLIST_TEMPLATE");
    }
    return best;
  }

  async findTemplate(kind: ChecklistKind, jobTitleId: string | null, departmentId: string | null) {
    const options = await this.db.checklistTemplate.findMany({
      where: {
        kind,
        active: true,
        // A person with no title fits only title-free templates; undefined here would match them all.
        AND: [
          jobTitleId === null ? { jobTitleId: null } : { OR: [{ jobTitleId: null }, { jobTitleId }] },
          departmentId === null ? { departmentId: null } : { OR: [{ departmentId: null }, { departmentId }] },
        ],
      },
      include: { items: { orderBy: { ordinal: "asc" } } },
    });
    const scored = options
      .map((one) => ({
        one,
        score: (one.jobTitleId ? 2 : 0) + (one.departmentId ? 1 : 0),
      }))
      .sort((a, b) => b.score - a.score);
    return scored[0]?.one ?? null;
  }

  /** Plant a run inside somebody else's transaction, or nothing when one is
   *  already there or no template fits (KEHOACH 9.14).
   */
  async plantIn(
    tx: Prisma.TransactionClient,
    person: Hire,
    kind: ChecklistKind,
    anchorDate: Date,
  ): Promise<{ runId: string; tasks: number } | null> {
    const held = await tx.checklistRun.findUnique({
      where: { employeeId_kind: { employeeId: person.id, kind } },
    });
    if (held) {
      return null;
    }
    const template = await this.findTemplate(kind, person.jobTitleId, person.departmentId);
    if (!template) {
      return null;
    }
    const made = await tx.checklistRun.create({
      data: {
        employeeId: person.id,
        templateId: template.id,
        kind,
        anchorDate,
        tasks: { create: tasksOf(template.items, person, anchorDate) },
      },
      select: { id: true },
    });
    return { runId: made.id, tasks: template.items.length };
  }

  /** Turn a template into work somebody owns, with dates it is due by. */
  async start(viewer: Viewer, body: StartRunDto): Promise<RunWithTasks> {
    const person = await this.db.employee.findUnique({
      where: { id: body.employeeId },
      select: { id: true, jobTitleId: true, departmentId: true, managerId: true },
    });
    if (!person) {
      throw new NotFoundException("EMPLOYEE_NOT_FOUND");
    }
    const held = await this.db.checklistRun.findUnique({
      where: { employeeId_kind: { employeeId: person.id, kind: body.kind } },
    });
    if (held) {
      throw new ConflictException("CHECKLIST_ALREADY_STARTED");
    }
    const template = await this.pickTemplate(body.kind, person.jobTitleId, person.departmentId);
    const anchor = new Date(body.anchorDate);
    return this.db.checklistRun
      .create({
        data: {
          employeeId: person.id,
          templateId: template.id,
          kind: body.kind,
          anchorDate: anchor,
          tasks: { create: tasksOf(template.items, person, anchor) },
        },
        include: { tasks: { orderBy: { ordinal: "asc" } }, template: { select: { name: true } } },
      })
      .catch((error: unknown) => {
        throw isCode(error, UNIQUE_VIOLATION) ? new ConflictException("CHECKLIST_ALREADY_STARTED") : error;
      });
  }

  /** One person's run, or null while none has been started: an empty tab, not a fault. */
  async run(viewer: Viewer, employeeId: number, kind: ChecklistKind): Promise<RunWithTasks | null> {
    const visible = await this.scope.visibleEmployeeIds(viewer);
    if (visible !== null && !visible.includes(employeeId)) {
      throw new NotFoundException("EMPLOYEE_NOT_FOUND");
    }
    return this.db.checklistRun.findUnique({
      where: { employeeId_kind: { employeeId, kind } },
      include: { tasks: { orderBy: { ordinal: "asc" } }, template: { select: { name: true } } },
    });
  }

  private async openWhere(viewer: Viewer, query: OpenCountsDto): Promise<Prisma.ChecklistTaskWhereInput> {
    const visible = await this.scope.visibleEmployeeIds(viewer);
    const branch = query.departmentId ? await departmentSubtree(this.db, query.departmentId) : null;
    const needle = query.search?.trim() ? { contains: query.search.trim(), mode: "insensitive" as const } : null;
    return {
      doneAt: null,
      run: {
        ...(visible === null ? {} : { employeeId: { in: visible } }),
        ...(query.kind ? { kind: query.kind } : {}),
        ...(branch ? { employee: { departmentId: { in: branch } } } : {}),
      },
      ...(needle
        ? {
            OR: [
              { title: needle },
              { run: { employee: { fullName: needle } } },
              { run: { employee: { code: needle } } },
            ],
          }
        : {}),
    };
  }

  /** What is still open and who it waits on, oldest due date first. */
  async open(viewer: Viewer, query: ListOpenTasksDto): Promise<Page<OpenTask>> {
    const where: Prisma.ChecklistTaskWhereInput = {
      ...(await this.openWhere(viewer, query)),
      ...(query.owner ? { ownerRole: query.owner } : {}),
      ...(query.overdue ? { dueOn: { lt: this.todayDate() } } : {}),
    };
    const [rows, found] = await Promise.all([
      this.db.checklistTask.findMany({
        where,
        include: OPEN_TASK,
        // Many tasks share a due date, so id settles where the cursor resumes (KEHOACH 9.9 rule 3).
        orderBy: [{ dueOn: "asc" }, { id: "asc" }],
        take: query.take,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : { skip: query.skip }),
      }),
      this.db.checklistTask.count({ where, take: COUNT_CEILING + 1 }),
    ]);
    const last = rows[rows.length - 1];
    return { ...countedTo(found), rows, next: rows.length === query.take && last ? last.id : null };
  }

  async openCounts(viewer: Viewer, query: OpenCountsDto): Promise<OpenCounts> {
    const where = await this.openWhere(viewer, query);
    const [byOwner, overdue] = await Promise.all([
      this.db.checklistTask.groupBy({ by: ["ownerRole"], where, _count: { _all: true } }),
      this.db.checklistTask.count({ where: { ...where, dueOn: { lt: this.todayDate() } } }),
    ]);
    const owners: Record<TaskOwner, number> = { HR: 0, MANAGER: 0, SELF: 0 };
    for (const row of byOwner) {
      owners[row.ownerRole] = row._count._all;
    }
    return { open: owners.HR + owners.MANAGER + owners.SELF, overdue, owners };
  }

  async finish(viewer: Viewer, taskId: string, body: FinishTaskDto): Promise<FinishedTask> {
    const task = await this.db.checklistTask.findUnique({
      where: { id: taskId },
      include: { run: { select: { employeeId: true } } },
    });
    if (!task) {
      throw new NotFoundException("TASK_NOT_FOUND");
    }
    const visible = await this.scope.visibleEmployeeIds(viewer);
    if (visible !== null && !visible.includes(task.run.employeeId)) {
      throw new NotFoundException("TASK_NOT_FOUND");
    }
    if (task.doneAt !== null) {
      throw new ConflictException("TASK_ALREADY_DONE");
    }
    // The person on the checklist ticks their own tasks, not the desk's or their manager's (KEHOACH 9.4).
    if (task.run.employeeId === viewer.employeeId && task.ownerRole !== "SELF") {
      throw new ForbiddenException("SELF_DECISION");
    }
    // Claimed by the update itself, so two people ticking at once cannot both be recorded.
    const claimed = await this.db.checklistTask.updateMany({
      where: { id: taskId, doneAt: null },
      data: { doneAt: new Date(), doneById: viewer.userId, note: body.note ?? null },
    });
    if (claimed.count === 0) {
      throw new ConflictException("TASK_ALREADY_DONE");
    }
    const done = await this.db.checklistTask.findUniqueOrThrow({ where: { id: taskId } });
    return { ...done, employeeId: task.run.employeeId };
  }
}

/** HR work belongs to a desk, so the person stays empty and the role carries it. */
function tasksOf(
  items: ChecklistTemplateItem[],
  person: Hire,
  anchor: Date,
): Prisma.ChecklistTaskUncheckedCreateWithoutRunInput[] {
  return items.map((item) => ({
    ordinal: item.ordinal,
    title: item.title,
    ownerRole: item.owner,
    ownerId: ownerOf(item.owner, person),
    dueOn: new Date(anchor.getTime() + item.dueDays * kMsPerDay),
  }));
}

function ownerOf(owner: TaskOwner, person: { id: number; managerId: number | null }): number | null {
  if (owner === "SELF") {
    return person.id;
  }
  if (owner === "MANAGER") {
    return person.managerId;
  }
  return null;
}
