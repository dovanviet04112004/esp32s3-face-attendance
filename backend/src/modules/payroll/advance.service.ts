import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { SalaryAdvance } from "@prisma/client";

import { COUNT_CEILING, countedTo } from "../../common/dto/cursor.dto.js";
import type { Page } from "../../common/dto/pagination.dto.js";
import { ScopeService } from "../../common/scope/scope.service.js";
import type { Viewer } from "../../common/scope/viewer.js";
import { PrismaService } from "../../database/prisma.service.js";
import { AUDIT_ACTIONS, AUDIT_SUBJECTS } from "../audit/audit-actions.js";
import { AuditService } from "../audit/audit.service.js";
import { LeaveService } from "../leave/leave.service.js";
import type { DecideAdvanceDto, ListAdvancesDto, RequestAdvanceDto } from "./dto/advance.dto.js";

const PAYERS: ReadonlySet<string> = new Set(["ADMIN", "PAYROLL"]);
const DECIDERS: ReadonlySet<string> = new Set(["ADMIN", "PAYROLL", "HR", "MANAGER"]);

@Injectable()
export class AdvanceService {
  constructor(
    private readonly db: PrismaService,
    private readonly scope: ScopeService,
    private readonly leave: LeaveService,
    private readonly audit: AuditService,
  ) {}

  async list(viewer: Viewer, query: ListAdvancesDto): Promise<Page<SalaryAdvance>> {
    const visible = await this.scope.visibleEmployeeIds(viewer);
    const where = {
      ...(visible === null ? {} : { employeeId: { in: visible } }),
      ...(query.state ? { state: query.state } : {}),
    };
    const [rows, found] = await Promise.all([
      this.db.salaryAdvance.findMany({
        where,
        include: { employee: { select: { id: true, code: true, fullName: true } } },
        // requestedAt repeats when a queue files several at once, so id
        // settles the order the cursor resumes from (KEHOACH 9.9 rule 3).
        orderBy: [{ requestedAt: "desc" }, { id: "asc" }],
        take: query.take,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      }),
      this.db.salaryAdvance.count({ where, take: COUNT_CEILING + 1 }),
    ]);
    const last = rows[rows.length - 1];
    return {
      ...countedTo(found),
      rows,
      next: rows.length === query.take && last ? last.id : null,
    };
  }

  async submit(viewer: Viewer, body: RequestAdvanceDto): Promise<SalaryAdvance> {
    if (viewer.employeeId === null) {
      throw new NotFoundException("EMPLOYEE_NOT_FOUND");
    }
    const approverId = await this.leave.approverFor(viewer.employeeId, new Date());
    return this.db.salaryAdvance.create({
      data: {
        employeeId: viewer.employeeId,
        amount: body.amount,
        reason: body.reason,
        approverId,
      },
    });
  }

  async decide(viewer: Viewer, id: string, body: DecideAdvanceDto): Promise<SalaryAdvance> {
    if (!DECIDERS.has(viewer.role)) {
      throw new ForbiddenException("ADVANCE_DECIDE_DENIED");
    }
    const found = await this.require(id);
    if (found.employeeId === viewer.employeeId) {
      throw new ForbiddenException("SELF_DECIDE");
    }
    if (found.state !== "PENDING") {
      throw new BadRequestException("ADVANCE_ALREADY_DECIDED");
    }
    const decided = await this.db.salaryAdvance.update({
      where: { id },
      data: {
        state: body.approve ? "APPROVED" : "REJECTED",
        decidedById: viewer.userId,
        decidedAt: new Date(),
        decisionNote: body.note ?? null,
      },
    });
    await this.audit.record({
      actorId: viewer.userId,
      action: body.approve ? AUDIT_ACTIONS.ADVANCE_APPROVE : AUDIT_ACTIONS.ADVANCE_REJECT,
      subject: AUDIT_SUBJECTS.ADVANCE,
      subjectId: id,
    });
    return decided;
  }

  /**
   * Money has left the account. Only from here does the next payroll run pick
   * it up, so an approval nobody paid never turns into a deduction.
   */
  async markPaid(viewer: Viewer, id: string): Promise<SalaryAdvance> {
    if (!PAYERS.has(viewer.role)) {
      throw new ForbiddenException("ADVANCE_PAY_DENIED");
    }
    const found = await this.require(id);
    if (found.state !== "APPROVED") {
      throw new BadRequestException("ADVANCE_NOT_APPROVED");
    }
    await this.audit.record({ actorId: viewer.userId, action: AUDIT_ACTIONS.ADVANCE_PAY,
      subject: AUDIT_SUBJECTS.ADVANCE, subjectId: id });
    return this.db.salaryAdvance.update({
      where: { id },
      data: { state: "PAID", paidAt: new Date() },
    });
  }

  async cancel(viewer: Viewer, id: string): Promise<SalaryAdvance> {
    const found = await this.require(id);
    if (found.employeeId !== viewer.employeeId) {
      throw new NotFoundException("ADVANCE_NOT_FOUND");
    }
    if (found.state !== "PENDING") {
      throw new BadRequestException("ADVANCE_ALREADY_DECIDED");
    }
    return this.db.salaryAdvance.update({ where: { id }, data: { state: "CANCELLED" } });
  }

  private async require(id: string): Promise<SalaryAdvance> {
    const found = await this.db.salaryAdvance.findUnique({ where: { id } });
    if (!found) {
      throw new NotFoundException("ADVANCE_NOT_FOUND");
    }
    return found;
  }
}
