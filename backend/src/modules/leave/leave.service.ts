import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type {
  LeaveBalance,
  LeaveType,
  Prisma,
  Request as LeaveRequest,
  RequestState,
} from "@prisma/client";

import type { Page } from "../../common/dto/pagination.dto.js";
import { ScopeService } from "../../common/scope/scope.service.js";
import type { Viewer } from "../../common/scope/viewer.js";
import { PrismaService } from "../../database/prisma.service.js";
import type { DecideRequestDto, ListRequestsDto, SubmitRequestDto } from "./dto/request.dto.js";

const EXCLUSION_VIOLATION = "23P01";
const HALF = 0.5;
const MS_PER_DAY = 86_400_000;

@Injectable()
export class LeaveService {
  private readonly log = new Logger(LeaveService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly scope: ScopeService,
  ) {}

  types(): Promise<LeaveType[]> {
    return this.db.leaveType.findMany({ where: { active: true }, orderBy: { code: "asc" } });
  }

  /** What this person has left of each kind, as of a day they choose. */
  async balances(employeeId: number, year: number): Promise<LeaveBalance[]> {
    return this.db.leaveBalance.findMany({
      where: { employeeId, year },
      include: { leaveType: { select: { id: true, code: true, name: true } } },
    });
  }

  async submit(viewer: Viewer, body: SubmitRequestDto): Promise<LeaveRequest> {
    if (viewer.employeeId === null) {
      throw new ForbiddenException("NOT_AN_EMPLOYEE");
    }
    const from = new Date(body.fromDate);
    const to = new Date(body.toDate);
    if (to < from) {
      throw new BadRequestException("DATE_RANGE_BACKWARDS");
    }
    const days = body.halfDay ? HALF : Math.round((to.getTime() - from.getTime()) / MS_PER_DAY) + 1;
    const approverId = await this.approverFor(viewer.employeeId, from);

    return this.db.$transaction(async (tx) => {
      if (body.kind === "LEAVE") {
        if (!body.leaveTypeId) {
          throw new BadRequestException("LEAVE_TYPE_REQUIRED");
        }
        await this.hold(tx, viewer.employeeId as number, body.leaveTypeId, from.getUTCFullYear(), days);
      }
      try {
        return await tx.request.create({
          data: {
            employeeId: viewer.employeeId as number,
            kind: body.kind,
            state: "PENDING",
            leaveTypeId: body.leaveTypeId ?? null,
            fromDate: from,
            toDate: to,
            halfDay: body.halfDay ?? false,
            days,
            minutes: body.minutes ?? 0,
            reason: body.reason,
            attachmentUrl: body.attachmentUrl ?? null,
            approverId,
          },
        });
      } catch (error) {
        if (isCode(error, EXCLUSION_VIOLATION)) {
          throw new ConflictException("LEAVE_OVERLAP");
        }
        throw error;
      }
    });
  }

  /** Approve or turn down, moving the balance only on the way through. */
  async decide(viewer: Viewer, id: string, body: DecideRequestDto): Promise<LeaveRequest> {
    const held = await this.db.request.findUnique({ where: { id } });
    if (!held) {
      throw new NotFoundException("REQUEST_NOT_FOUND");
    }
    if (held.state !== "PENDING") {
      throw new ConflictException("REQUEST_ALREADY_DECIDED");
    }
    await this.mayDecide(viewer, held.employeeId);
    const next: RequestState = body.approve ? "APPROVED" : "REJECTED";

    return this.db.$transaction(async (tx) => {
      if (held.kind === "LEAVE" && held.leaveTypeId) {
        await this.settle(tx, held, body.approve);
      }
      return tx.request.update({
        where: { id },
        data: {
          state: next,
          decidedById: viewer.userId,
          decidedAt: new Date(),
          decisionNote: body.note ?? null,
        },
      });
    });
  }

  /** What is waiting on this viewer to answer. */
  async inbox(viewer: Viewer, query: ListRequestsDto): Promise<Page<LeaveRequest>> {
    if (viewer.employeeId === null) {
      return { rows: [], total: 0 };
    }
    const standIn = await this.standingInFor(viewer.employeeId);
    const where: Prisma.RequestWhereInput = {
      state: "PENDING",
      approverId: { in: [viewer.employeeId, ...standIn] },
      ...(query.kind ? { kind: query.kind } : {}),
    };
    return this.page(where, query);
  }

  async list(viewer: Viewer, query: ListRequestsDto): Promise<Page<LeaveRequest>> {
    const visible = await this.scope.visibleEmployeeIds(viewer);
    const where: Prisma.RequestWhereInput = {
      ...ScopeService.narrow("employeeId", visible),
      ...(query.state ? { state: query.state } : {}),
      ...(query.kind ? { kind: query.kind } : {}),
    };
    if (query.employeeId !== undefined) {
      if (visible !== null && !visible.includes(query.employeeId)) {
        return { rows: [], total: 0 };
      }
      where.employeeId = query.employeeId;
    }
    return this.page(where, query);
  }

  /** Cancelling gives held days back; a decided request is past cancelling. */
  async cancel(viewer: Viewer, id: string): Promise<LeaveRequest> {
    const held = await this.db.request.findUnique({ where: { id } });
    if (!held || held.employeeId !== viewer.employeeId) {
      throw new NotFoundException("REQUEST_NOT_FOUND");
    }
    if (held.state !== "PENDING") {
      throw new ConflictException("REQUEST_ALREADY_DECIDED");
    }
    return this.db.$transaction(async (tx) => {
      if (held.kind === "LEAVE" && held.leaveTypeId) {
        await this.release(tx, held);
      }
      return tx.request.update({ where: { id }, data: { state: "CANCELLED" } });
    });
  }

  private async page(where: Prisma.RequestWhereInput, query: ListRequestsDto): Promise<Page<LeaveRequest>> {
    const [rows, total] = await this.db.$transaction([
      this.db.request.findMany({
        where,
        orderBy: { createdAt: "desc" },
        skip: query.skip,
        take: query.take,
        include: {
          employee: { select: { id: true, code: true, fullName: true } },
          leaveType: { select: { id: true, code: true, name: true } },
        },
      }),
      this.db.request.count({ where }),
    ]);
    return { rows, total };
  }

  private async mayDecide(viewer: Viewer, employeeId: number): Promise<void> {
    if (["ADMIN", "HR"].includes(viewer.role)) {
      return;
    }
    const visible = await this.scope.visibleEmployeeIds(viewer);
    if (visible !== null && visible.includes(employeeId) && employeeId !== viewer.employeeId) {
      return;
    }
    // Deciding your own request is the one thing a manager may not do.
    throw new ForbiddenException("NOT_YOUR_REQUEST");
  }

  /** Who decides for this person on a date, honouring a delegation. */
  async approverFor(employeeId: number, on: Date): Promise<number | null> {
    const person = await this.db.employee.findUnique({
      where: { id: employeeId },
      select: { managerId: true },
    });
    if (!person?.managerId) {
      return null;
    }
    const away = await this.db.approvalDelegation.findFirst({
      where: { fromId: person.managerId, fromDate: { lte: on }, toDate: { gte: on } },
      select: { toId: true },
    });
    return away?.toId ?? person.managerId;
  }

  private async standingInFor(employeeId: number): Promise<number[]> {
    const today = new Date();
    const rows = await this.db.approvalDelegation.findMany({
      where: { toId: employeeId, fromDate: { lte: today }, toDate: { gte: today } },
      select: { fromId: true },
    });
    return rows.map((row) => row.fromId);
  }

  private async hold(tx: Prisma.TransactionClient, employeeId: number, leaveTypeId: string, year: number, days: number): Promise<void> {
    const balance = await tx.leaveBalance.findUnique({
      where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year } },
    });
    const left = balance
      ? Number(balance.entitled) + Number(balance.carriedOver) - Number(balance.taken) - Number(balance.pending)
      : 0;
    if (left < days) {
      throw new ConflictException("LEAVE_BALANCE_SHORT");
    }
    await tx.leaveBalance.update({
      where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId, year } },
      data: { pending: { increment: days } },
    });
  }

  private async settle(tx: Prisma.TransactionClient, held: LeaveRequest, approved: boolean): Promise<void> {
    const key = {
      employeeId: held.employeeId,
      leaveTypeId: held.leaveTypeId as string,
      year: held.fromDate.getUTCFullYear(),
    };
    await tx.leaveBalance.update({
      where: { employeeId_leaveTypeId_year: key },
      data: {
        pending: { decrement: held.days },
        ...(approved ? { taken: { increment: held.days } } : {}),
      },
    });
  }

  private async release(tx: Prisma.TransactionClient, held: LeaveRequest): Promise<void> {
    await tx.leaveBalance.update({
      where: {
        employeeId_leaveTypeId_year: {
          employeeId: held.employeeId,
          leaveTypeId: held.leaveTypeId as string,
          year: held.fromDate.getUTCFullYear(),
        },
      },
      data: { pending: { decrement: held.days } },
    });
  }
}

// Prisma wraps a raw SQLSTATE in the message rather than surfacing it as a
// field, so the constraint name is what identifies it.
function isCode(error: unknown, code: string): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const meta = (error as { meta?: { code?: string } }).meta;
  if (meta?.code === code || (error as { code?: string }).code === code) {
    return true;
  }
  const message = (error as { message?: string }).message ?? "";
  return message.includes(code);
}
