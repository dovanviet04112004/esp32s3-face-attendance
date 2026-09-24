import { ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type {
  ChecklistKind,
  ChecklistTask,
  ChecklistTemplate,
  ChecklistTemplateItem,
  Prisma,
  TaskOwner,
} from "@prisma/client";

import { ScopeService } from "../../common/scope/scope.service.js";
import type { Viewer } from "../../common/scope/viewer.js";
import { PrismaService } from "../../database/prisma.service.js";
import type { CreateTemplateDto, FinishTaskDto, StartRunDto } from "./dto/onboarding.dto.js";

export type RunWithTasks = Prisma.ChecklistRunGetPayload<{
  include: { tasks: true; template: { select: { name: true } } };
}>;

const kMsPerDay = 86_400_000;
const kOpenPage = 200;

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
  ) {}

  templates(kind?: ChecklistKind): Promise<ChecklistTemplate[]> {
    return this.db.checklistTemplate.findMany({
      where: { active: true, ...(kind ? { kind } : {}) },
      include: { items: { orderBy: { ordinal: "asc" } } },
      orderBy: { name: "asc" },
    });
  }

  createTemplate(body: CreateTemplateDto): Promise<ChecklistTemplate> {
    return this.db.checklistTemplate.create({
      data: {
        kind: body.kind,
        name: body.name,
        jobTitleId: body.jobTitleId ?? null,
        departmentId: body.departmentId ?? null,
        items: {
          create: body.items.map((item, at) => ({
            ordinal: at + 1,
            title: item.title,
            owner: item.owner,
            dueDays: item.dueDays,
          })),
        },
      },
      include: { items: { orderBy: { ordinal: "asc" } } },
    });
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
        AND: [
          { OR: [{ jobTitleId: null }, { jobTitleId: jobTitleId ?? undefined }] },
          { OR: [{ departmentId: null }, { departmentId: departmentId ?? undefined }] },
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
    return this.db.checklistRun.create({
      data: {
        employeeId: person.id,
        templateId: template.id,
        kind: body.kind,
        anchorDate: anchor,
        tasks: { create: tasksOf(template.items, person, anchor) },
      },
      include: { tasks: { orderBy: { ordinal: "asc" } }, template: { select: { name: true } } },
    });
  }

  async run(viewer: Viewer, employeeId: number, kind: ChecklistKind): Promise<RunWithTasks> {
    const visible = await this.scope.visibleEmployeeIds(viewer);
    if (visible !== null && !visible.includes(employeeId)) {
      throw new NotFoundException("EMPLOYEE_NOT_FOUND");
    }
    const found = await this.db.checklistRun.findUnique({
      where: { employeeId_kind: { employeeId, kind } },
      include: { tasks: { orderBy: { ordinal: "asc" } }, template: { select: { name: true } } },
    });
    if (!found) {
      throw new NotFoundException("CHECKLIST_NOT_FOUND");
    }
    return found;
  }

  /** What is still open and who it waits on, oldest due date first. */
  async open(viewer: Viewer): Promise<ChecklistTask[]> {
    const visible = await this.scope.visibleEmployeeIds(viewer);
    return this.db.checklistTask.findMany({
      where: {
        doneAt: null,
        ...(visible === null ? {} : { run: { employeeId: { in: visible } } }),
      },
      include: {
        run: {
          select: { kind: true, employee: { select: { id: true, code: true, fullName: true } } },
        },
      },
      orderBy: { dueOn: "asc" },
      take: kOpenPage,
    });
  }

  async finish(viewer: Viewer, taskId: string, body: FinishTaskDto): Promise<ChecklistTask> {
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
    return this.db.checklistTask.update({
      where: { id: taskId },
      data: { doneAt: new Date(), doneById: viewer.userId, note: body.note ?? null },
    });
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
