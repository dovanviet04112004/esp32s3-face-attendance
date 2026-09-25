import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { PayslipDispute, Prisma } from "@prisma/client";

import { COUNT_CEILING, countedTo, nextCursor } from "../../common/dto/cursor.dto.js";
import type { Page } from "../../common/dto/pagination.dto.js";
import { ScopeService } from "../../common/scope/scope.service.js";
import type { Viewer } from "../../common/scope/viewer.js";
import type { Env } from "../../config/env.schema.js";
import { PrismaService } from "../../database/prisma.service.js";
import { AUDIT_ACTIONS, AUDIT_SUBJECTS } from "../audit/audit-actions.js";
import { AuditService } from "../audit/audit.service.js";
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
import type { AnswerDisputeDto, ListDisputesDto, RaiseDisputeDto } from "./dto/dispute.dto.js";

const ANSWERERS = QUEUE_DESKS.disputes;

const DISPUTE_VIEW = {
  employee: PERSON_VIEW,
  payslip: { select: { period: { select: { year: true, month: true } } } },
} satisfies Prisma.PayslipDisputeInclude;

type Listed = Prisma.PayslipDisputeGetPayload<{ include: typeof DISPUTE_VIEW }>;

export interface DisputeRow extends Listed {
  waitedDays: number;
}
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
    await this.notices.raiseToDesk(ANSWERERS, "REQUEST_WAITING", { payslipId: slip.id }, {
      employeeIds: [viewer.employeeId],
    });
    return made;
  }

  /** Pay disputes are pay-type data: the desk reads all, everyone else their own (KEHOACH 9.4). */
  async list(viewer: Viewer, query: ListDisputesDto): Promise<Page<DisputeRow>> {
    const visible = await this.scope.deskOrSelfEmployeeIds(viewer);
    const person = await personWhere(this.db, query);
    const waiting = query.state === "OPEN" || query.overdue === true;
    // Spread would let a later key overwrite `state` and quietly answer a
    // different question than the one asked.
    const where = {
      AND: [
        whoseRows(visible, query.employeeId),
        notOwnWaiting(viewer, ANSWERERS, waiting, query.employeeId),
        query.state ? { state: query.state } : {},
        query.overdue ? { state: "OPEN", dueAt: { lt: new Date() } } : {},
        person ? { employee: person } : {},
        filedBetween("createdAt", query, this.config.get("APP_TIMEZONE", { infer: true })),
      ],
    } as Prisma.PayslipDisputeWhereInput;
    const order = query.order ?? (waiting ? "asc" : "desc");
    const resumed = query.cursor
      ? { AND: [where, resumeAfter("createdAt", order, query.cursor) as Prisma.PayslipDisputeWhereInput] }
      : where;
    const [rows, found] = await Promise.all([
      this.db.payslipDispute.findMany({
        where: resumed,
        skip: query.cursor ? 0 : query.skip,
        take: query.take,
        orderBy: sortedBy("createdAt", order) as Prisma.PayslipDisputeOrderByWithRelationInput[],
        include: DISPUTE_VIEW,
      }),
      this.db.payslipDispute.count({ where, take: COUNT_CEILING + 1 }),
    ]);
    const now = new Date();
    return {
      rows: rows.map((row) => ({ ...row, waitedDays: waitedDays(row.createdAt, now) })),
      ...countedTo(found),
      next: nextCursor(rows, query.take, (row) => row.createdAt),
    };
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
    // Payroll answering its own claim would settle its own back pay (KEHOACH 9.4).
    if (held.employeeId === viewer.employeeId) {
      throw new ForbiddenException("SELF_DECISION");
    }
    const slip = await this.db.payslip.findUniqueOrThrow({
      where: { id: held.payslipId },
      select: { periodId: true },
    });
    const answered = await this.db.$transaction(async (tx) => {
      // The state is claimed first, so a second answer racing this one mints no second adjustment.
      const claimed = await tx.payslipDispute.updateMany({
        where: { id: held.id, state: "OPEN" },
        data: {
          state: "ANSWERED",
          outcome: body.outcome,
          answer: body.answer,
          answeredAt: new Date(),
          answeredById: viewer.userId,
        },
      });
      if (claimed.count !== 1) {
        throw new BadRequestException("DISPUTE_ALREADY_ANSWERED");
      }
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
      return tx.payslipDispute.update({ where: { id: held.id }, data: { retroId: paid?.id ?? null } });
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
    const claimed = await this.db.payslipDispute.updateMany({
      where: { id: held.id, state: "OPEN" },
      data: { state: "WITHDRAWN" },
    });
    if (claimed.count !== 1) {
      throw new BadRequestException("DISPUTE_ALREADY_ANSWERED");
    }
    const dropped = await this.db.payslipDispute.findUniqueOrThrow({ where: { id: held.id } });
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
