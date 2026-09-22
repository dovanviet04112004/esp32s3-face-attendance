import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { PayslipDispute, Prisma } from "@prisma/client";

import { COUNT_CEILING, countedTo } from "../../common/dto/cursor.dto.js";
import type { Page } from "../../common/dto/pagination.dto.js";
import { ScopeService } from "../../common/scope/scope.service.js";
import type { Viewer } from "../../common/scope/viewer.js";
import type { Env } from "../../config/env.schema.js";
import { PrismaService } from "../../database/prisma.service.js";
import { AUDIT_ACTIONS, AUDIT_SUBJECTS } from "../audit/audit-actions.js";
import { AuditService } from "../audit/audit.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import type { AnswerDisputeDto, ListDisputesDto, RaiseDisputeDto } from "./dto/dispute.dto.js";

const ANSWERERS = ["ADMIN", "PAYROLL"];
const HOURS_PER_DAY = 24;
const MS_PER_HOUR = 3_600_000;
const RETRO_CODE = "DISPUTE";

@Injectable()
export class DisputesService {
  private readonly log = new Logger(DisputesService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly notices: NotificationsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Dispute a figure on a payslip that has already gone out. */
  async raise(viewer: Viewer, body: RaiseDisputeDto): Promise<PayslipDispute> {
    if (viewer.employeeId === null) {
      throw new ForbiddenException("NO_EMPLOYEE_RECORD");
    }
    const slip = await this.db.payslip.findUnique({
      where: { id: body.payslipId },
      select: { id: true, employeeId: true, state: true },
    });
    if (!slip || slip.employeeId !== viewer.employeeId) {
      throw new NotFoundException("PAYSLIP_NOT_FOUND");
    }
    if (slip.state === "DRAFT") {
      throw new BadRequestException("PAYSLIP_NOT_ISSUED");
    }
    const lineCode = body.lineCode ?? null;
    const already = await this.db.payslipDispute.count({
      where: { payslipId: slip.id, lineCode, state: "OPEN" },
    });
    if (already > 0) {
      throw new ConflictException("DISPUTE_ALREADY_OPEN");
    }
    const days = this.config.get("DISPUTE_ANSWER_DAYS", { infer: true });
    const made = await this.db.payslipDispute.create({
      data: {
        payslipId: slip.id,
        employeeId: viewer.employeeId,
        lineCode,
        claim: body.claim,
        dueAt: new Date(Date.now() + days * HOURS_PER_DAY * MS_PER_HOUR),
      },
    });
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.DISPUTE_RAISE,
      subject: AUDIT_SUBJECTS.PAYROLL,
      subjectId: slip.id,
      meta: { lineCode, dueAt: made.dueAt.toISOString() },
    });
    return made;
  }

  async list(viewer: Viewer, query: ListDisputesDto): Promise<Page<PayslipDispute>> {
    const visible = await this.scope.visibleEmployeeIds(viewer);
    // Spread would let a later key overwrite `state` and quietly answer a
    // different question than the one asked.
    const where: Prisma.PayslipDisputeWhereInput = {
      AND: [
        ScopeService.narrow("employeeId", visible),
        query.state ? { state: query.state } : {},
        query.employeeId ? { employeeId: query.employeeId } : {},
        query.overdue ? { state: "OPEN", dueAt: { lt: new Date() } } : {},
      ],
    };
    const [rows, found] = await Promise.all([
      this.db.payslipDispute.findMany({
        where,
        skip: query.skip,
        take: query.take,
        orderBy: [{ state: "asc" }, { dueAt: "asc" }],
        include: {
          employee: { select: { code: true, fullName: true } },
          payslip: { select: { period: { select: { year: true, month: true } } } },
        },
      }),
      this.db.payslipDispute.count({ where, take: COUNT_CEILING + 1 }),
    ]);
    return { rows, ...countedTo(found) };
  }

  /**
   * Answer one. Upholding with an amount mints the adjustment that carries it
   * into the next period, because a locked one stays locked (KEHOACH 9.6).
   */
  async answer(viewer: Viewer, id: string, body: AnswerDisputeDto): Promise<PayslipDispute> {
    if (!ANSWERERS.includes(viewer.role)) {
      throw new ForbiddenException("PAYROLL_WRITE_DENIED");
    }
    const held = await this.open(id);
    const slip = await this.db.payslip.findUniqueOrThrow({
      where: { id: held.payslipId },
      select: { periodId: true },
    });
    const answered = await this.db.$transaction(async (tx) => {
      const paid =
        body.outcome === "UPHELD" && body.amount !== undefined
          ? await tx.retroAdjustment.create({
              data: {
                employeeId: held.employeeId,
                sourcePeriodId: slip.periodId,
                code: body.code ?? RETRO_CODE,
                label: body.label ?? null,
                amount: String(body.amount),
                reason: body.answer,
                createdById: viewer.userId,
              },
            })
          : null;
      return tx.payslipDispute.update({
        where: { id: held.id },
        data: {
          state: "ANSWERED",
          outcome: body.outcome,
          answer: body.answer,
          answeredAt: new Date(),
          answeredById: viewer.userId,
          retroId: paid?.id ?? null,
        },
      });
    });
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.DISPUTE_ANSWER,
      subject: AUDIT_SUBJECTS.PAYROLL,
      subjectId: held.payslipId,
      meta: { outcome: body.outcome, retroId: answered.retroId, amount: body.amount ?? null },
    });
    await this.notices.raiseFor(held.employeeId, "DISPUTE_ANSWERED", { payslipId: held.payslipId });
    this.log.log(`dispute ${held.id} answered ${body.outcome}`);
    return answered;
  }

  /** Take one back. Only the person who raised it, and only while it is open. */
  async withdraw(viewer: Viewer, id: string): Promise<PayslipDispute> {
    const held = await this.open(id);
    if (held.employeeId !== viewer.employeeId) {
      throw new ForbiddenException("DISPUTE_NOT_YOURS");
    }
    const dropped = await this.db.payslipDispute.update({
      where: { id: held.id },
      data: { state: "WITHDRAWN" },
    });
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.DISPUTE_WITHDRAW,
      subject: AUDIT_SUBJECTS.PAYROLL,
      subjectId: held.payslipId,
      meta: { lineCode: held.lineCode },
    });
    return dropped;
  }

  private async open(id: string): Promise<PayslipDispute> {
    const held = await this.db.payslipDispute.findUnique({ where: { id } });
    if (!held) {
      throw new NotFoundException("DISPUTE_NOT_FOUND");
    }
    if (held.state !== "OPEN") {
      throw new BadRequestException("DISPUTE_ALREADY_ANSWERED");
    }
    return held;
  }
}
