import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Prisma, SalaryAdvance } from "@prisma/client";

import { COUNT_CEILING, countedTo, nextCursor } from "../../common/dto/cursor.dto.js";
import type { Page } from "../../common/dto/pagination.dto.js";
import { ScopeService } from "../../common/scope/scope.service.js";
import type { Viewer } from "../../common/scope/viewer.js";
import type { Env } from "../../config/env.schema.js";
import { PrismaService } from "../../database/prisma.service.js";
import { AUDIT_ACTIONS, AUDIT_SUBJECTS } from "../audit/audit-actions.js";
import { AuditService } from "../audit/audit.service.js";
import { LeaveService } from "../leave/leave.service.js";
import {
  PERSON_VIEW,
  QUEUE_DESKS,
  filedBetween,
  notOwnWaiting,
  personWhere,
  resumeAfter,
  sortedBy,
  waitedDays,
  whoseRows,
} from "../leave/queue-filter.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import type { DecideAdvanceDto, ListAdvancesDto, RequestAdvanceDto } from "./dto/advance.dto.js";

const SORT_FIELD = "requestedAt";
// Money handed out and not yet taken back by a payslip.
const OWED: SalaryAdvance["state"][] = ["APPROVED", "PAID"];

type Listed = Prisma.SalaryAdvanceGetPayload<{ include: { employee: typeof PERSON_VIEW } }>;

export interface AdvanceRow extends Listed {
  waitedDays: number;
  baseSalary: string | null;
  outstanding: string | null;
}

@Injectable()
export class AdvanceService {
  constructor(
    private readonly db: PrismaService,
    private readonly scope: ScopeService,
    private readonly leave: LeaveService,
    private readonly audit: AuditService,
    private readonly notices: NotificationsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async list(viewer: Viewer, query: ListAdvancesDto): Promise<Page<AdvanceRow>> {
    const visible = await this.scope.deskOrSelfEmployeeIds(viewer);
    const person = await personWhere(this.db, query);
    const own =
      query.state === "PENDING"
        ? notOwnWaiting(viewer, QUEUE_DESKS.advancesToDecide, true, query.employeeId)
        : notOwnWaiting(viewer, QUEUE_DESKS.advancesToPay, query.state === "APPROVED", query.employeeId);
    const where = {
      AND: [
        whoseRows(visible, query.employeeId),
        own,
        query.state ? { state: query.state } : {},
        person ? { employee: person } : {},
        filedBetween(SORT_FIELD, query, this.config.get("APP_TIMEZONE", { infer: true })),
      ],
    } as Prisma.SalaryAdvanceWhereInput;
    const order = query.order ?? (query.state === "PENDING" || query.state === "APPROVED" ? "asc" : "desc");
    const resumed = query.cursor
      ? { AND: [where, resumeAfter(SORT_FIELD, order, query.cursor) as Prisma.SalaryAdvanceWhereInput] }
      : where;
    const [rows, found] = await Promise.all([
      this.db.salaryAdvance.findMany({
        where: resumed,
        include: { employee: PERSON_VIEW },
        orderBy: sortedBy(SORT_FIELD, order) as Prisma.SalaryAdvanceOrderByWithRelationInput[],
        skip: query.cursor ? 0 : query.skip,
        take: query.take,
      }),
      this.db.salaryAdvance.count({ where, take: COUNT_CEILING + 1 }),
    ]);
    return {
      ...countedTo(found),
      rows: await this.withContext(rows, visible === null),
      next: nextCursor(rows, query.take, (row) => row.requestedAt),
    };
  }

  // What the desk weighs an advance against (KEHOACH 9.15); never computed for anyone else.
  private async withContext(rows: Listed[], desk: boolean): Promise<AdvanceRow[]> {
    const now = new Date();
    const people = [...new Set(rows.map((row) => row.employeeId))];
    const [pay, owed] =
      desk && people.length > 0
        ? await Promise.all([
            this.db.compensationRecord.findMany({
              where: { employeeId: { in: people }, effectiveFrom: { lte: now } },
              orderBy: [{ employeeId: "asc" }, { effectiveFrom: "desc" }],
              distinct: ["employeeId"],
              select: { employeeId: true, baseSalary: true },
            }),
            this.db.salaryAdvance.findMany({
              where: { employeeId: { in: people }, state: { in: OWED } },
              select: { id: true, employeeId: true, amount: true },
            }),
          ])
        : [[], []];
    const salaryOf = new Map(pay.map((one) => [one.employeeId, one.baseSalary.toFixed(0)]));
    return rows.map((row) => ({
      ...row,
      waitedDays: waitedDays(row.requestedAt, now),
      baseSalary: desk ? (salaryOf.get(row.employeeId) ?? null) : null,
      outstanding: desk
        ? owed
            .filter((one) => one.employeeId === row.employeeId && one.id !== row.id)
            .reduce((sum, one) => sum + Number(one.amount), 0)
            .toFixed(0)
        : null,
    }));
  }

  async submit(viewer: Viewer, body: RequestAdvanceDto): Promise<SalaryAdvance> {
    if (viewer.employeeId === null) {
      throw new NotFoundException("EMPLOYEE_NOT_FOUND");
    }
    const filed = await this.db.salaryAdvance.create({
      data: {
        employeeId: viewer.employeeId,
        amount: body.amount,
        reason: body.reason,
      },
    });
    await this.notices.raiseMany(
      await this.leave.deskIds(viewer.employeeId),
      "REQUEST_WAITING",
      { advanceId: filed.id },
    );
    return filed;
  }

  async decide(viewer: Viewer, id: string, body: DecideAdvanceDto): Promise<SalaryAdvance> {
    if (!QUEUE_DESKS.advancesToDecide.includes(viewer.role)) {
      throw new ForbiddenException("ADVANCE_DECIDE_DENIED");
    }
    const found = await this.require(id);
    if (found.employeeId === viewer.employeeId) {
      throw new ForbiddenException("SELF_DECISION");
    }
    // Guarded on the state, so a withdrawal or a second desk landing first leaves this one refused.
    const claimed = await this.db.salaryAdvance.updateMany({
      where: { id, state: "PENDING" },
      data: {
        state: body.approve ? "APPROVED" : "REJECTED",
        decidedById: viewer.userId,
        decidedAt: new Date(),
        decisionNote: body.note ?? null,
      },
    });
    if (claimed.count !== 1) {
      throw new BadRequestException("ADVANCE_ALREADY_DECIDED");
    }
    const decided = await this.require(id);
    await this.audit.record({
      actorId: viewer.userId,
      action: body.approve ? AUDIT_ACTIONS.ADVANCE_APPROVE : AUDIT_ACTIONS.ADVANCE_REJECT,
      subject: AUDIT_SUBJECTS.ADVANCE,
      subjectId: id,
    });
    await this.notices.raiseFor(found.employeeId, "REQUEST_DECIDED", {
      advanceId: id,
      approved: body.approve,
    });
    return decided;
  }

  /**
   * Money has left the account. Only from here does the next payroll run pick
   * it up, so an approval nobody paid never turns into a deduction.
   */
  async markPaid(viewer: Viewer, id: string): Promise<SalaryAdvance> {
    if (!QUEUE_DESKS.advancesToPay.includes(viewer.role)) {
      throw new ForbiddenException("ADVANCE_PAY_DENIED");
    }
    const found = await this.require(id);
    // Paying oneself is deciding one's own money a second time (KEHOACH 9.4).
    if (found.employeeId === viewer.employeeId) {
      throw new ForbiddenException("SELF_DECISION");
    }
    const claimed = await this.db.salaryAdvance.updateMany({
      where: { id, state: "APPROVED" },
      data: { state: "PAID", paidAt: new Date() },
    });
    if (claimed.count !== 1) {
      throw new BadRequestException("ADVANCE_NOT_APPROVED");
    }
    await this.audit.record({ actorId: viewer.userId, action: AUDIT_ACTIONS.ADVANCE_PAY,
      subject: AUDIT_SUBJECTS.ADVANCE, subjectId: id });
    return this.require(id);
  }

  async cancel(viewer: Viewer, id: string): Promise<SalaryAdvance> {
    const found = await this.require(id);
    if (found.employeeId !== viewer.employeeId) {
      throw new NotFoundException("ADVANCE_NOT_FOUND");
    }
    const claimed = await this.db.salaryAdvance.updateMany({
      where: { id, state: "PENDING" },
      data: { state: "CANCELLED" },
    });
    if (claimed.count !== 1) {
      throw new BadRequestException("ADVANCE_ALREADY_DECIDED");
    }
    return this.require(id);
  }

  private async require(id: string): Promise<SalaryAdvance> {
    const found = await this.db.salaryAdvance.findUnique({ where: { id } });
    if (!found) {
      throw new NotFoundException("ADVANCE_NOT_FOUND");
    }
    return found;
  }
}
