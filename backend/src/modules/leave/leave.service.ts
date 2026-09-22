import { BadRequestException, ConflictException, ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type {
  LeaveBalance,
  LeaveType,
  Prisma,
  Request as LeaveRequest,
  RequestKind,
  RequestState,
  Role,
} from "@prisma/client";

import type { Page } from "../../common/dto/pagination.dto.js";
import { ScopeService } from "../../common/scope/scope.service.js";
import type { Viewer } from "../../common/scope/viewer.js";
import { PrismaService } from "../../database/prisma.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { TimesheetService } from "../timesheet/timesheet.service.js";
import type { DecideRequestDto, ListRequestsDto, SubmitRequestDto } from "./dto/request.dto.js";

const EXCLUSION_VIOLATION = "23P01";
const UNIQUE_VIOLATION = "P2002";
const HALF = 0.5;
const MS_PER_DAY = 86_400_000;
const OFF_SITE: RequestKind[] = ["BUSINESS_TRIP", "REMOTE_WORK"];
// The same two roles mayDecide already lets through, and the ones 9.4 gives
// leave to; an unclaimed request waits here.
const THE_DESK: Role[] = ["ADMIN", "HR"];

/** One person's standing in one leave type, on a day they picked. */
export interface BalanceAsOf {
  leaveTypeId: string;
  code: string;
  name: string;
  paid: boolean;
  year: number;
  entitled: number;
  carriedOver: number;
  taken: number;
  pending: number;
  remaining: number;
  bookedAfter: number;
}

type Countable = Pick<LeaveBalance, "entitled" | "carriedOver" | "taken" | "pending">;

/** Days still free to book. The one place this subtraction happens. */
export function freeDays(balance: Countable): number {
  return (
    Number(balance.entitled) +
    Number(balance.carriedOver) -
    Number(balance.taken) -
    Number(balance.pending)
  );
}

@Injectable()
export class LeaveService {
  private readonly log = new Logger(LeaveService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly scope: ScopeService,
    private readonly notices: NotificationsService,
    private readonly timesheet: TimesheetService,
  ) {}

  types(): Promise<LeaveType[]> {
    return this.db.leaveType.findMany({ where: { active: true }, orderBy: { code: "asc" } });
  }

  /**
   * What this person still has to book in the leave year a chosen day falls
   * in. A day held by a request nobody has answered is a day already gone,
   * so it leaves `remaining` the moment the request is filed.
   */
  /** Somebody's balance, theirs by default. Asking about another person goes
   *  through the same scope as reading their record does.
   */
  async balancesFor(viewer: Viewer, employeeId: number | undefined, asOf: Date): Promise<BalanceAsOf[]> {
    const whose = employeeId ?? viewer.employeeId;
    if (whose === null || whose === undefined) {
      return [];
    }
    const visible = await this.scope.visibleEmployeeIds(viewer);
    if (visible !== null && !visible.includes(whose)) {
      throw new NotFoundException("EMPLOYEE_NOT_FOUND");
    }
    return this.balancesAsOf(whose, asOf);
  }

  async balancesAsOf(employeeId: number, asOf: Date): Promise<BalanceAsOf[]> {
    const year = asOf.getUTCFullYear();
    const yearEnd = new Date(Date.UTC(year, 11, 31));
    const [rows, later] = await Promise.all([
      this.db.leaveBalance.findMany({
        where: { employeeId, year },
        include: { leaveType: { select: { id: true, code: true, name: true, paid: true } } },
        orderBy: { leaveType: { code: "asc" } },
      }),
      this.db.request.groupBy({
        by: ["leaveTypeId"],
        where: {
          employeeId,
          kind: "LEAVE",
          state: { in: ["PENDING", "APPROVED"] },
          fromDate: { gt: asOf, lte: yearEnd },
        },
        _sum: { days: true },
      }),
    ]);
    const afterwards = new Map(later.map((one) => [one.leaveTypeId, Number(one._sum.days ?? 0)]));
    return rows.map((row) => ({
      leaveTypeId: row.leaveTypeId,
      code: row.leaveType.code,
      name: row.leaveType.name,
      paid: row.leaveType.paid,
      year,
      entitled: Number(row.entitled),
      carriedOver: Number(row.carriedOver),
      taken: Number(row.taken),
      pending: Number(row.pending),
      remaining: freeDays(row),
      bookedAfter: afterwards.get(row.leaveTypeId) ?? 0,
    }));
  }

  async submit(viewer: Viewer, body: SubmitRequestDto): Promise<LeaveRequest> {
    if (viewer.employeeId === null) {
      throw new ForbiddenException("NOT_AN_EMPLOYEE");
    }
    // A redelivery from a phone that lost the answer ends where the first one
    // did, rather than filing a second request (KEHOACH 9.21.3 rule 2).
    if (body.clientKey !== undefined) {
      const already = await this.db.request.findUnique({ where: { clientKey: body.clientKey } });
      if (already) {
        if (already.employeeId !== viewer.employeeId) {
          throw new ForbiddenException("CLIENT_KEY_NOT_YOURS");
        }
        return already;
      }
    }
    const from = new Date(body.fromDate);
    const to = new Date(body.toDate);
    if (to < from) {
      throw new BadRequestException("DATE_RANGE_BACKWARDS");
    }
    if (body.kind === "ATTENDANCE_FIX") {
      this.checkFixable(from, to);
    }
    const days = body.halfDay ? HALF : Math.round((to.getTime() - from.getTime()) / MS_PER_DAY) + 1;
    const approverId = await this.approverFor(viewer.employeeId, from);

    const file = (): Promise<LeaveRequest> => this.db.$transaction(async (tx) => {
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
            clientKey: body.clientKey ?? null,
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

    let filed: LeaveRequest;
    try {
      filed = await file();
    } catch (error) {
      // Two redeliveries can both miss the read above. Letting this throw is
      // what rolls back the leave days the loser had already reserved.
      const raced =
        body.clientKey !== undefined && isCode(error, UNIQUE_VIOLATION)
          ? await this.db.request.findUnique({ where: { clientKey: body.clientKey } })
          : null;
      if (!raced) {
        throw error;
      }
      if (raced.employeeId !== viewer.employeeId) {
        throw new ForbiddenException("CLIENT_KEY_NOT_YOURS");
      }
      return raced;
    }
    if (approverId !== null) {
      await this.notices.raiseFor(approverId, "REQUEST_WAITING", { requestId: filed.id });
    } else {
      await this.notices.raiseMany(
        await this.deskIds(viewer.employeeId as number),
        "REQUEST_WAITING",
        { requestId: filed.id },
      );
    }
    return filed;
  }

  /** One finished day: a longer range leaves `minutes` ambiguous, and a day
   *  still running would freeze at the claimed figure, because a corrected day
   *  is the one thing the nightly build will not touch.
   */
  private checkFixable(from: Date, to: Date): void {
    if (from.getTime() !== to.getTime()) {
      throw new BadRequestException("FIX_ONE_DAY_ONLY");
    }
    if (from.toISOString().slice(0, 10) >= this.timesheet.today()) {
      throw new BadRequestException("FIX_DAY_NOT_FINISHED");
    }
  }

  /** One request, if this viewer is allowed to know it exists. */
  async one(viewer: Viewer, id: string): Promise<LeaveRequest> {
    const held = await this.db.request.findUnique({
      where: { id },
      include: {
        employee: { select: { id: true, code: true, fullName: true } },
        leaveType: { select: { id: true, code: true, name: true } },
      },
    });
    const visible = await this.scope.visibleEmployeeIds(viewer);
    if (!held || (visible !== null && !visible.includes(held.employeeId))) {
      throw new NotFoundException("REQUEST_NOT_FOUND");
    }
    return held;
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

    const decided = await this.db.$transaction(async (tx) => {
      if (held.kind === "LEAVE" && held.leaveTypeId) {
        await this.settle(tx, held, body.approve);
      }
      if (held.kind === "LEAVE" && !held.halfDay && body.approve) {
        await this.timesheet.markApproved(tx, held.employeeId, held.fromDate, held.toDate, "LEAVE");
      }
      // Registered in advance, so a kiosk that never sees their face is not
      // evidence of anything (KEHOACH 9.17 item 3).
      if (OFF_SITE.includes(held.kind) && body.approve) {
        await this.timesheet.markApproved(tx, held.employeeId, held.fromDate, held.toDate, "WORKED");
      }
      if (held.kind === "ATTENDANCE_FIX" && body.approve) {
        await this.timesheet.applyFix(
          tx,
          held.employeeId,
          held.fromDate,
          held.minutes,
          viewer.userId,
          held.reason,
        );
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
    await this.notices.raiseFor(held.employeeId, "REQUEST_DECIDED", {
      requestId: id,
      approved: body.approve,
    });
    return decided;
  }

  /** What is waiting on this viewer to answer. */
  async inbox(viewer: Viewer, query: ListRequestsDto): Promise<Page<LeaveRequest>> {
    const mine: Prisma.RequestWhereInput[] = [];
    if (viewer.employeeId !== null) {
      const standIn = await this.standingInFor(viewer.employeeId);
      mine.push({ approverId: { in: [viewer.employeeId, ...standIn] } });
    }
    // Nobody above the person who asked, so it waits on the desk that holds
    // leave anyway rather than on nobody (KEHOACH 9.15).
    if (THE_DESK.includes(viewer.role)) {
      mine.push({
        approverId: null,
        ...(viewer.employeeId === null ? {} : { employeeId: { not: viewer.employeeId } }),
      });
    }
    if (mine.length === 0) {
      return { rows: [], total: 0 };
    }
    const where: Prisma.RequestWhereInput = {
      state: "PENDING",
      OR: mine,
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

  /** The desk an unclaimed request waits on, minus whoever asked: rule 2 holds
   *  even when the queue is a role rather than a person (KEHOACH 9.15).
   */
  async deskIds(asker: number): Promise<string[]> {
    const rows = await this.db.user.findMany({
      where: { active: true, role: { in: THE_DESK } },
      select: { id: true, employeeId: true },
    });
    return rows.filter((row) => row.employeeId !== asker).map((row) => row.id);
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
    const left = balance ? freeDays(balance) : 0;
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
