import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { NoticeQueue, Prisma, Role } from "@prisma/client";

import { isUnlinkedDesk, type Viewer } from "../../common/scope/viewer.js";
import type { Env } from "../../config/env.schema.js";
import { PrismaService } from "../../database/prisma.service.js";
import { QUEUE_DESKS, THE_DESK } from "../leave/queue-filter.js";
import { dayAsDate, dayWindow, localDay } from "../timesheet/local-day.js";
import { INBOX_ROLES } from "./notice-kinds.js";

/** The where clause each queue's table takes. */
export interface QueueWhere {
  REQUESTS: Prisma.RequestWhereInput;
  ADVANCES_TO_DECIDE: Prisma.SalaryAdvanceWhereInput;
  ADVANCES_TO_PAY: Prisma.SalaryAdvanceWhereInput;
  CERTIFICATES: Prisma.CertificateWhereInput;
  PROFILE_CHANGES: Prisma.ProfileChangeWhereInput;
  DISPUTES: Prisma.PayslipDisputeWhereInput;
  DEPENDENTS: Prisma.DependentWhereInput;
}

export type InboxQueue = keyof QueueWhere;

/** The state a queue's business row holds while it waits; any other state closes its item (KEHOACH 9.21.4). */
export const WAITING_STATE = {
  REQUESTS: "PENDING",
  ADVANCES_TO_DECIDE: "PENDING",
  ADVANCES_TO_PAY: "APPROVED",
  CERTIFICATES: "REQUESTED",
  PROFILE_CHANGES: "PENDING",
  DISPUTES: "OPEN",
  DEPENDENTS: "PENDING",
} as const satisfies Record<InboxQueue, string>;

/** Where a queue's business rows live, and the column a wait in that queue counts from (KEHOACH 9.17 item 12). */
export const QUEUE_LEDGER: Record<InboxQueue, { table: string; since: string }> = {
  REQUESTS: { table: "Request", since: "createdAt" },
  ADVANCES_TO_DECIDE: { table: "SalaryAdvance", since: "requestedAt" },
  ADVANCES_TO_PAY: { table: "SalaryAdvance", since: "decidedAt" },
  CERTIFICATES: { table: "Certificate", since: "createdAt" },
  PROFILE_CHANGES: { table: "ProfileChange", since: "createdAt" },
  DISPUTES: { table: "PayslipDispute", since: "createdAt" },
  DEPENDENTS: { table: "Dependent", since: "createdAt" },
};

const DESK_OF: Record<Exclude<InboxQueue, "REQUESTS">, keyof typeof QUEUE_DESKS> = {
  ADVANCES_TO_DECIDE: "advancesToDecide",
  ADVANCES_TO_PAY: "advancesToPay",
  CERTIFICATES: "certificates",
  PROFILE_CHANGES: "profileChanges",
  DISPUTES: "disputes",
  DEPENDENTS: "dependents",
};

const ESCALATE_ON_DAY = 7;

const HR_DESK: Role[] = ["ADMIN", "HR"];

// An approver counts only with an open login whose role opens the inbox (KEHOACH 9.21.4).
const UNREACHABLE = {
  NOT: { login: { is: { active: true, role: { in: [...INBOX_ROLES] } } } },
} satisfies Prisma.EmployeeWhereInput;

interface Candidate {
  id: string;
  role: Role;
  employeeId: number | null;
}

/** Who a piece of work waits on: the inbox asks it per viewer, the bell per item, one rule for both (KEHOACH 9.21.4). */
@Injectable()
export class AudienceService {
  constructor(
    private readonly db: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** The rows of a queue waiting on this viewer, as a where clause on the queue's table; null when none can.
   *  @ctx any | reads approval delegations for the requests queue
   */
  async waitingOn<Q extends InboxQueue>(viewer: Viewer, queue: Q): Promise<QueueWhere[Q] | null> {
    if (!INBOX_ROLES.includes(viewer.role) || isUnlinkedDesk(viewer)) {
      return null;
    }
    const notOwn = viewer.employeeId === null ? {} : { employeeId: { not: viewer.employeeId } };
    if (queue === "REQUESTS") {
      return (await this.requestsWaitingOn(viewer, notOwn)) as QueueWhere[Q] | null;
    }
    if (!QUEUE_DESKS[DESK_OF[queue as Exclude<InboxQueue, "REQUESTS">]].includes(viewer.role)) {
      return null;
    }
    const waiting: Record<Exclude<InboxQueue, "REQUESTS">, object> = {
      ADVANCES_TO_DECIDE: { state: WAITING_STATE.ADVANCES_TO_DECIDE, ...notOwn },
      ADVANCES_TO_PAY: { state: WAITING_STATE.ADVANCES_TO_PAY, ...notOwn },
      CERTIFICATES: { state: WAITING_STATE.CERTIFICATES, ...notOwn },
      // Whoever asked on someone's behalf neither sees nor decides it (KEHOACH 9.17 item 6 rule 2).
      PROFILE_CHANGES: {
        state: WAITING_STATE.PROFILE_CHANGES,
        ...notOwn,
        OR: [{ askedById: null }, { askedById: { not: viewer.userId } }],
      },
      DISPUTES: { state: WAITING_STATE.DISPUTES, ...notOwn },
      DEPENDENTS: { state: WAITING_STATE.DEPENDENTS, ...notOwn },
    };
    return waiting[queue as Exclude<InboxQueue, "REQUESTS">] as QueueWhere[Q];
  }

  /** A desk list of waiting rows narrowed to what waits on the viewer; other lists keep the viewer's scope.
   *  @ctx any | the inbox tabs read their rows through this, so the tabs and the bell agree
   */
  async inboxNarrowing(
    viewer: Viewer,
    queue: Exclude<InboxQueue, "REQUESTS">,
    waiting: boolean,
    askedFor?: number,
  ): Promise<object> {
    const decides = QUEUE_DESKS[DESK_OF[queue]].includes(viewer.role);
    if (!waiting || !decides || (askedFor !== undefined && askedFor === viewer.employeeId)) {
      return {};
    }
    return (await this.waitingOn(viewer, queue)) ?? { id: { in: [] } };
  }

  /** Every open login a subject waits on, found by asking waitingOn of each login that could hold it.
   *  @ctx any | one count per candidate login
   *  @param employeeId the person that work of one person is about, as a document to sign or a day to explain
   */
  async audienceOf(queue: NoticeQueue, subjectId: string, employeeId: number | null = null): Promise<string[]> {
    if (queue === "CONTRACTS_DUE" || queue === "PROBATION_DUE") {
      return this.dueAudience(queue, subjectId);
    }
    if (queue === "BACKUP" || queue === "KIOSK") {
      return this.admins();
    }
    if (queue === "TASKS") {
      return this.taskAudience(subjectId);
    }
    if (queue === "DOCUMENTS" || queue === "ATTENDANCE") {
      return this.ownLogins(employeeId);
    }
    const candidates = await this.candidates(queue, subjectId);
    const held: string[] = [];
    for (const one of candidates) {
      const where = await this.waitingOn({ userId: one.id, role: one.role, employeeId: one.employeeId }, queue);
      if (where !== null && (await this.holds(queue, subjectId, where))) {
        held.push(one.id);
      }
    }
    return held;
  }

  private async admins(): Promise<string[]> {
    const held = await this.db.user.findMany({ where: { active: true, role: "ADMIN" }, select: { id: true } });
    return held.map((one) => one.id);
  }

  // The desk that signs, never the person about it; a probation also the manager who judges it (KEHOACH 9.18 items 1-2).
  private async dueAudience(queue: "CONTRACTS_DUE" | "PROBATION_DUE", contractId: string): Promise<string[]> {
    const held = await this.db.employmentContract.findUnique({
      where: { id: contractId },
      select: { employeeId: true, employee: { select: { managerId: true } } },
    });
    if (!held) {
      return [];
    }
    const seated = await this.hrDesk(held.employeeId);
    const boss = queue === "PROBATION_DUE" && held.employee.managerId !== null ? await this.managerLogin(held.employee.managerId) : null;
    return [...new Set([...seated, ...(boss ? [boss] : [])])];
  }

  // The owner of a task: the person, the manager it named, or the desk once that manager has no open login (KEHOACH 9.21.4).
  private async taskAudience(taskId: string): Promise<string[]> {
    const task = await this.db.checklistTask.findUnique({
      where: { id: taskId },
      select: { ownerRole: true, ownerId: true, run: { select: { employeeId: true } } },
    });
    if (!task) {
      return [];
    }
    const about = task.run.employeeId;
    if (task.ownerRole === "SELF") {
      return this.ownLogins(about);
    }
    const boss = task.ownerRole === "MANAGER" && task.ownerId !== null ? await this.managerLogin(task.ownerId) : null;
    return boss ? [boss] : this.hrDesk(about);
  }

  // ADMIN and HR, never the person the work is about, and only a desk with a record of its own (KEHOACH 9.4).
  private async hrDesk(aboutEmployeeId: number): Promise<string[]> {
    const desk = await this.db.user.findMany({
      where: {
        active: true,
        role: { in: HR_DESK },
        OR: [{ employeeId: null }, { employeeId: { not: aboutEmployeeId } }],
      },
      select: { id: true, role: true, employeeId: true },
    });
    return desk.filter((one) => !isUnlinkedDesk({ userId: one.id, role: one.role, employeeId: one.employeeId })).map((one) => one.id);
  }

  private async ownLogins(employeeId: number | null): Promise<string[]> {
    if (employeeId === null) {
      return [];
    }
    const own = await this.db.user.findMany({ where: { employeeId, active: true }, select: { id: true } });
    return own.map((one) => one.id);
  }

  private async managerLogin(employeeId: number): Promise<string | null> {
    const boss = await this.db.user.findFirst({
      where: { employeeId, active: true, role: { in: [...INBOX_ROLES] } },
      select: { id: true },
    });
    return boss?.id ?? null;
  }

  /** The whole working day of the company a request reaches the desk on (KEHOACH 9.21.4). */
  escalatedBefore(): Date {
    const zone = this.config.get("APP_TIMEZONE", { infer: true });
    const today = dayAsDate(localDay(new Date(), zone));
    const first = new Date(today.getTime() - (ESCALATE_ON_DAY - 2) * 86_400_000).toISOString().slice(0, 10);
    return dayWindow(first, zone).from;
  }

  private async requestsWaitingOn(viewer: Viewer, notOwn: object): Promise<Prisma.RequestWhereInput | null> {
    const mine: Prisma.RequestWhereInput[] = [];
    if (viewer.employeeId !== null) {
      mine.push({ approverId: { in: [viewer.employeeId, ...(await this.standingInFor(viewer.employeeId))] } });
    }
    if (THE_DESK.includes(viewer.role)) {
      mine.push(
        { approverId: null, ...notOwn },
        { approver: { is: UNREACHABLE }, ...notOwn },
        { createdAt: { lt: this.escalatedBefore() }, ...notOwn },
      );
    }
    return mine.length === 0 ? null : { state: WAITING_STATE.REQUESTS, OR: mine };
  }

  private async standingInFor(employeeId: number): Promise<number[]> {
    const today = dayAsDate(localDay(new Date(), this.config.get("APP_TIMEZONE", { infer: true })));
    const rows = await this.db.approvalDelegation.findMany({
      where: { toId: employeeId, fromDate: { lte: today }, toDate: { gte: today } },
      select: { fromId: true },
    });
    return rows.map((row) => row.fromId);
  }

  private async candidates(queue: InboxQueue, subjectId: string): Promise<Candidate[]> {
    const open = { active: true, role: { in: [...INBOX_ROLES] } } satisfies Prisma.UserWhereInput;
    const select = { id: true, role: true, employeeId: true } as const;
    if (queue !== "REQUESTS") {
      const roles = QUEUE_DESKS[DESK_OF[queue]];
      return this.db.user.findMany({ where: { ...open, role: { in: roles } }, select });
    }
    const held = await this.db.request.findUnique({ where: { id: subjectId }, select: { approverId: true } });
    const people = held?.approverId ? [held.approverId, ...(await this.standingInForOthers(held.approverId))] : [];
    return this.db.user.findMany({
      where: { ...open, OR: [{ employeeId: { in: people } }, { role: { in: THE_DESK } }] },
      select,
    });
  }

  private async standingInForOthers(approverId: number): Promise<number[]> {
    const today = dayAsDate(localDay(new Date(), this.config.get("APP_TIMEZONE", { infer: true })));
    const rows = await this.db.approvalDelegation.findMany({
      where: { fromId: approverId, fromDate: { lte: today }, toDate: { gte: today } },
      select: { toId: true },
    });
    return rows.map((row) => row.toId);
  }

  private async holds(queue: InboxQueue, subjectId: string, where: object): Promise<boolean> {
    const one = { AND: [{ id: subjectId }, where] };
    const counted: Record<InboxQueue, () => Promise<number>> = {
      REQUESTS: () => this.db.request.count({ where: one as Prisma.RequestWhereInput }),
      ADVANCES_TO_DECIDE: () => this.db.salaryAdvance.count({ where: one as Prisma.SalaryAdvanceWhereInput }),
      ADVANCES_TO_PAY: () => this.db.salaryAdvance.count({ where: one as Prisma.SalaryAdvanceWhereInput }),
      CERTIFICATES: () => this.db.certificate.count({ where: one as Prisma.CertificateWhereInput }),
      PROFILE_CHANGES: () => this.db.profileChange.count({ where: one as Prisma.ProfileChangeWhereInput }),
      DISPUTES: () => this.db.payslipDispute.count({ where: one as Prisma.PayslipDisputeWhereInput }),
      DEPENDENTS: () => this.db.dependent.count({ where: one as Prisma.DependentWhereInput }),
    };
    return (await counted[queue]()) > 0;
  }
}

/** The inbox queues are the NoticeQueue values the approvals page lists. */
export const INBOX_QUEUES: readonly InboxQueue[] = [
  "REQUESTS",
  "ADVANCES_TO_DECIDE",
  "ADVANCES_TO_PAY",
  "CERTIFICATES",
  "PROFILE_CHANGES",
  "DISPUTES",
  "DEPENDENTS",
] satisfies readonly NoticeQueue[];
