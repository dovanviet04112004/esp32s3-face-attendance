import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type {
  LeaveBalance,
  LeaveType,
  Prisma,
  Request as LeaveRequest,
  RequestKind,
  RequestState,
} from "@prisma/client";

import { toExcelCsv } from "../../common/csv.js";
import { COUNT_CEILING, countedTo, nextCursor } from "../../common/dto/cursor.dto.js";
import type { Page } from "../../common/dto/pagination.dto.js";
import { ScopeService } from "../../common/scope/scope.service.js";
import type { Viewer } from "../../common/scope/viewer.js";
import type { Env } from "../../config/env.schema.js";
import { PrismaService } from "../../database/prisma.service.js";
import { AUDIT_ACTIONS, AUDIT_SUBJECTS } from "../audit/audit-actions.js";
import { AuditService } from "../audit/audit.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { dayAsDate } from "../timesheet/local-day.js";
import { TimesheetService } from "../timesheet/timesheet.service.js";
import type { CreateLeaveTypeDto, UpdateLeaveTypeDto } from "./dto/leave-type.dto.js";
import type { Order } from "./dto/queue.dto.js";
import type {
  DecideManyDto,
  DecideRequestDto,
  LeaveDaysQueryDto,
  ListRequestsDto,
  RequestSort,
  SubmitRequestDto,
} from "./dto/request.dto.js";
import { LeaveYearService } from "./leave-year.service.js";
import {
  PERSON_VIEW,
  QUEUE_DESKS,
  THE_DESK,
  filedBetween,
  personWhere,
  resumeAfter,
  sortedBy,
  waitedDays,
} from "./queue-filter.js";

export { THE_DESK } from "./queue-filter.js";

const EXCLUSION_VIOLATION = "23P01";
const UNIQUE_VIOLATION = "P2002";
const HALF = 0.5;
const MS_PER_DAY = 86_400_000;
const MS_PER_MINUTE = 60_000;
const OFF_SITE: RequestKind[] = ["BUSINESS_TRIP", "REMOTE_WORK"];
const TIMED: RequestKind[] = ["OVERTIME", "ATTENDANCE_FIX"];
const OFF_WORK: RequestState[] = ["PENDING", "APPROVED"];
const OVERLAP_SHOWN = 20;
// Past this an export stops; a filter narrows it (KEHOACH 9.9 rule 6).
const EXPORT_MAX = 50_000;
const EXPORT_COLUMNS = [
  "code", "fullName", "department", "kind", "leaveType", "fromDate", "toDate", "days",
  "state", "reason", "createdAt", "decidedBy", "decidedAt", "decisionNote",
];

const REQUEST_VIEW = {
  employee: PERSON_VIEW,
  leaveType: { select: { id: true, code: true, name: true, paid: true } },
} satisfies Prisma.RequestInclude;

type Filed = Prisma.RequestGetPayload<{ include: typeof REQUEST_VIEW }>;

export interface Decider {
  id: string;
  email: string;
  fullName: string | null;
}

export type RequestRow = Filed & { decidedBy: Decider | null };

export interface InboxRow extends RequestRow {
  waitedDays: number;
  balanceAfter: number | null;
  nextBalanceAfter: number | null;
  overlapCount: number | null;
}

export interface Overlap {
  id: string;
  fromDate: Date;
  toDate: Date;
  state: RequestState;
  employee: Filed["employee"];
}

export interface RequestDetail extends RequestRow {
  balance: BalanceAsOf | null;
  nextBalance: BalanceAsOf | null;
  overlapping: Overlap[];
  mayDecide: boolean;
}

/** What waits on one viewer in every queue of the inbox; the badge sums these. */
export interface InboxCounts {
  requests: number;
  disputes: number;
  certificates: number;
  profileChanges: number;
  dependents: number;
  advancesToDecide: number;
  advancesToPay: number;
}

export interface DecideManyResult {
  decided: string[];
  skipped: { id: string; code: string }[];
}

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
  carriedOut: number;
  remaining: number;
  bookedAfter: number;
}

/** The working days a range charges to one calendar year. */
export interface YearPart {
  year: number;
  days: number;
}

/** What a proposed leave would charge, and what each year it touches keeps afterwards. */
export interface LeaveDays {
  days: number;
  limited: boolean;
  parts: (YearPart & { left: number | null })[];
}

interface Charge {
  days: number;
  nextYearDays: number;
}

type Countable = Pick<LeaveBalance, "entitled" | "carriedOver" | "taken" | "pending" | "carriedOut">;

/** Days still free to book. The one place this subtraction happens. */
export function freeDays(balance: Countable): number {
  return (
    Number(balance.entitled) +
    Number(balance.carriedOver) -
    Number(balance.taken) -
    Number(balance.pending) -
    Number(balance.carriedOut)
  );
}

/** The days a request charges to each year it touches, as stored at filing (KEHOACH 9.5). */
export function partsOf(held: { fromDate: Date; days: Prisma.Decimal | number; nextYearDays: Prisma.Decimal | number }): YearPart[] {
  const year = held.fromDate.getUTCFullYear();
  const next = Number(held.nextYearDays);
  return [
    { year, days: Number(held.days) - next },
    { year: year + 1, days: next },
  ].filter((part) => part.days > 0);
}

@Injectable()
export class LeaveService {
  private readonly log = new Logger(LeaveService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly scope: ScopeService,
    private readonly notices: NotificationsService,
    private readonly timesheet: TimesheetService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env, true>,
    private readonly years: LeaveYearService,
  ) {}

  private get zone(): string {
    return this.config.get("APP_TIMEZONE", { infer: true });
  }

  types(): Promise<LeaveType[]> {
    return this.db.leaveType.findMany({ where: { active: true }, orderBy: { code: "asc" } });
  }

  /** Every kind, retired ones included, which is what a desk editing them
   *  needs and what the filing form must not offer.
   */
  allTypes(): Promise<LeaveType[]> {
    return this.db.leaveType.findMany({ orderBy: [{ active: "desc" }, { code: "asc" }] });
  }

  async createType(viewer: Viewer, body: CreateLeaveTypeDto): Promise<LeaveType> {
    try {
      const made = await this.db.leaveType.create({
        data: {
          code: body.code,
          name: body.name,
          paid: body.paid ?? true,
          daysPerYear: body.daysPerYear,
          carryOverMax: body.carryOverMax ?? 0,
        },
      });
      await this.audit.record({
        actorId: viewer.userId,
        action: AUDIT_ACTIONS.LEAVE_TYPE_CREATE,
        subject: AUDIT_SUBJECTS.LEAVE_TYPE,
        subjectId: made.id,
        meta: { code: made.code, daysPerYear: body.daysPerYear },
      });
      return made;
    } catch (error: unknown) {
      if (isCode(error, UNIQUE_VIOLATION)) {
        throw new ConflictException("LEAVE_TYPE_CODE_TAKEN");
      }
      throw error;
    }
  }

  /** This sets what the next grant hands out. A balance row already on a
   *  person keeps its own numbers (KEHOACH 9.5).
   */
  async updateType(viewer: Viewer, id: string, body: UpdateLeaveTypeDto): Promise<LeaveType> {
    const held = await this.db.leaveType.findUnique({ where: { id } });
    if (!held) {
      throw new NotFoundException("LEAVE_TYPE_NOT_FOUND");
    }
    const saved = await this.db.leaveType.update({ where: { id }, data: body });
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.LEAVE_TYPE_UPDATE,
      subject: AUDIT_SUBJECTS.LEAVE_TYPE,
      subjectId: id,
      meta: { code: saved.code, ...body },
    });
    return saved;
  }

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

  /** An unpaid type has no balance to show: nothing limits it (KEHOACH 9.5). */
  async balancesAsOf(employeeId: number, asOf: Date): Promise<BalanceAsOf[]> {
    const year = asOf.getUTCFullYear();
    const yearEnd = new Date(Date.UTC(year, 11, 31));
    const [rows, later] = await Promise.all([
      this.db.leaveBalance.findMany({
        where: { employeeId, year, leaveType: { paid: true } },
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
        _sum: { days: true, nextYearDays: true },
      }),
    ]);
    const afterwards = new Map(
      later.map((one) => [one.leaveTypeId, Number(one._sum.days ?? 0) - Number(one._sum.nextYearDays ?? 0)]),
    );
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
      carriedOut: Number(row.carriedOut),
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
    if (body.halfDay && from.getTime() !== to.getTime()) {
      throw new BadRequestException("HALF_DAY_ONE_DAY_ONLY");
    }
    const fromAt = body.fromAt ? new Date(body.fromAt) : null;
    const toAt = body.toAt ? new Date(body.toAt) : null;
    if (fromAt && toAt && toAt <= fromAt) {
      throw new BadRequestException("TIME_RANGE_BACKWARDS");
    }
    const minutes =
      fromAt && toAt && TIMED.includes(body.kind)
        ? Math.round((toAt.getTime() - fromAt.getTime()) / MS_PER_MINUTE)
        : (body.minutes ?? 0);
    const type = body.kind === "LEAVE" ? await this.fileableType(body.leaveTypeId) : null;
    const { days, nextYearDays } = type
      ? await this.charge(viewer.employeeId, from, to, body.halfDay ?? false)
      : { days: body.halfDay ? HALF : Math.round((to.getTime() - from.getTime()) / MS_PER_DAY) + 1, nextYearDays: 0 };
    const approverId = await this.approverFor(viewer.employeeId, from);

    const file = (): Promise<LeaveRequest> => this.db.$transaction(async (tx) => {
      if (type) {
        await this.hold(tx, viewer.employeeId as number, type, partsOf({ fromDate: from, days, nextYearDays }));
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
            dayPart: body.halfDay ? (body.dayPart ?? null) : null,
            days,
            nextYearDays,
            minutes,
            fromAt,
            toAt,
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

  /** What a proposed leave would charge per year, by the same count filing uses, so a browser never counts a calendar. */
  async leaveDays(viewer: Viewer, query: LeaveDaysQueryDto): Promise<LeaveDays> {
    if (viewer.employeeId === null) {
      throw new ForbiddenException("NOT_AN_EMPLOYEE");
    }
    const from = new Date(query.fromDate);
    const to = new Date(query.toDate);
    if (to < from) {
      throw new BadRequestException("DATE_RANGE_BACKWARDS");
    }
    if (query.halfDay && from.getTime() !== to.getTime()) {
      throw new BadRequestException("HALF_DAY_ONE_DAY_ONLY");
    }
    const type = query.leaveTypeId ? await this.fileableType(query.leaveTypeId) : null;
    const charge = await this.charge(viewer.employeeId, from, to, query.halfDay ?? false);
    const parts = partsOf({ fromDate: from, ...charge });
    const whose = viewer.employeeId;
    const lefts = await Promise.all(
      parts.map(async (part) => {
        if (!type?.paid) {
          return null;
        }
        const key = { employeeId: whose, leaveTypeId: type.id };
        const row = await this.db.leaveBalance.findUnique({
          where: { employeeId_leaveTypeId_year: { ...key, year: part.year } },
        });
        return (row ? freeDays(row) : await this.years.projected(key, part.year)) - part.days;
      }),
    );
    return {
      days: charge.days,
      limited: type?.paid ?? true,
      parts: parts.map((part, at) => ({ ...part, left: lefts[at] ?? null })),
    };
  }

  private async fileableType(id: string | undefined): Promise<Pick<LeaveType, "id" | "paid">> {
    if (!id) {
      throw new BadRequestException("LEAVE_TYPE_REQUIRED");
    }
    const type = await this.db.leaveType.findUnique({ where: { id }, select: { id: true, paid: true, active: true } });
    // A retired type stays on the requests that named it and is offered to no new one.
    if (!type?.active) {
      throw new NotFoundException("LEAVE_TYPE_NOT_FOUND");
    }
    return type;
  }

  /** Working days only, each charged to the calendar year it falls in (KEHOACH 9.5). */
  private async charge(employeeId: number, from: Date, to: Date, halfDay: boolean): Promise<Charge> {
    const startYear = from.getUTCFullYear();
    if (to.getUTCFullYear() > startYear + 1) {
      throw new BadRequestException("LEAVE_SPANS_YEARS");
    }
    const working = await this.timesheet.workdays(employeeId, from, to);
    if (halfDay) {
      if (working.length === 0) {
        throw new BadRequestException("HALF_DAY_NOT_WORKING");
      }
      return { days: HALF, nextYearDays: 0 };
    }
    if (working.length === 0) {
      throw new BadRequestException("LEAVE_NO_WORKING_DAY");
    }
    return {
      days: working.length,
      nextYearDays: working.filter((day) => day.getUTCFullYear() > startYear).length,
    };
  }

  /** One request, if this viewer may know it exists: its tree, or waiting on them to decide. */
  async one(viewer: Viewer, id: string): Promise<RequestDetail> {
    const held = await this.db.request.findUnique({ where: { id }, include: REQUEST_VIEW });
    if (!held) {
      throw new NotFoundException("REQUEST_NOT_FOUND");
    }
    const visible = await this.scope.visibleEmployeeIds(viewer);
    const refusal = held.state === "PENDING" ? await this.refusal(viewer, held) : "NOT_PENDING";
    if (visible !== null && !visible.includes(held.employeeId) && refusal !== null) {
      throw new NotFoundException("REQUEST_NOT_FOUND");
    }
    const balanceOn = (asOf: Date): Promise<BalanceAsOf | null> =>
      held.kind === "LEAVE" && held.leaveTypeId
        ? this.balancesAsOf(held.employeeId, asOf).then(
            (rows) => rows.find((one) => one.leaveTypeId === held.leaveTypeId) ?? null,
          )
        : Promise.resolve(null);
    const split = Number(held.nextYearDays) > 0;
    const [[row], balance, nextBalance, overlapping] = await Promise.all([
      this.withDeciders([held]),
      balanceOn(held.fromDate),
      split ? balanceOn(new Date(Date.UTC(held.fromDate.getUTCFullYear() + 1, 0, 1))) : Promise.resolve(null),
      held.kind === "LEAVE" ? this.overlapping(held) : Promise.resolve([]),
    ]);
    return { ...row, balance, nextBalance, overlapping, mayDecide: refusal === null };
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
    const refusal = await this.refusal(viewer, held);
    if (refusal === "SELF_DECISION") {
      throw new ForbiddenException("SELF_DECISION");
    }
    if (refusal !== null) {
      throw new ForbiddenException("NOT_YOUR_REQUEST");
    }
    const next: RequestState = body.approve ? "APPROVED" : "REJECTED";

    const decided = await this.db.$transaction(async (tx) => {
      // Two deciders can both read PENDING above; only the write that lands moves the balance.
      const claimed = await tx.request.updateMany({
        where: { id, state: "PENDING" },
        data: {
          state: next,
          decidedById: viewer.userId,
          decidedAt: new Date(),
          decisionNote: body.note ?? null,
        },
      });
      if (claimed.count !== 1) {
        throw new ConflictException("REQUEST_ALREADY_DECIDED");
      }
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
      return tx.request.findUniqueOrThrow({ where: { id } });
    });
    await this.notices.raiseFor(held.employeeId, "REQUEST_DECIDED", {
      requestId: id,
      approved: body.approve,
    });
    return decided;
  }

  /** Several at once, each through the rules of one decision; a refused row is reported, not fatal. */
  async decideMany(viewer: Viewer, body: DecideManyDto): Promise<DecideManyResult> {
    if (!body.approve && !body.note?.trim()) {
      throw new BadRequestException("DECISION_NOTE_REQUIRED");
    }
    const result: DecideManyResult = { decided: [], skipped: [] };
    // One at a time: two decisions on one balance row would only queue on its lock anyway.
    for (const id of new Set(body.ids)) {
      try {
        await this.decide(viewer, id, { approve: body.approve, note: body.note });
        result.decided.push(id);
      } catch (fell) {
        if (!(fell instanceof HttpException)) {
          throw fell;
        }
        result.skipped.push({ id, code: fell.message });
      }
    }
    return result;
  }

  /** What is waiting on this viewer to answer, oldest first unless asked otherwise. */
  async inbox(viewer: Viewer, query: ListRequestsDto): Promise<Page<InboxRow>> {
    const mine = await this.waitingOnViewer(viewer);
    if (mine.length === 0) {
      return { rows: [], total: 0, totalIsExact: true, next: null };
    }
    const where: Prisma.RequestWhereInput = {
      AND: [{ state: "PENDING", OR: mine }, ...(await this.filters(query))],
    };
    const page = await this.page(where, "createdAt", query.order ?? "asc", query);
    return { ...page, rows: await this.withContext(page.rows) };
  }

  /** The numbers on the inbox tabs and the sidebar badge, from the same rules as each list. */
  async counts(viewer: Viewer): Promise<InboxCounts> {
    const mine = await this.waitingOnViewer(viewer);
    const own = viewer.employeeId === null ? {} : { employeeId: { not: viewer.employeeId } };
    const decides = (queue: keyof typeof QUEUE_DESKS): boolean => QUEUE_DESKS[queue].includes(viewer.role);
    const take = COUNT_CEILING;
    const none = Promise.resolve(0);
    const [requests, disputes, certificates, profileChanges, dependents, advancesToDecide, advancesToPay] =
      await Promise.all([
        mine.length === 0 ? none : this.db.request.count({ where: { state: "PENDING", OR: mine }, take }),
        decides("disputes") ? this.db.payslipDispute.count({ where: { state: "OPEN", ...own }, take }) : none,
        decides("certificates") ? this.db.certificate.count({ where: { state: "REQUESTED", ...own }, take }) : none,
        decides("profileChanges") ? this.db.profileChange.count({ where: { state: "PENDING", ...own }, take }) : none,
        decides("dependents") ? this.db.dependent.count({ where: { state: "PENDING", ...own }, take }) : none,
        decides("advancesToDecide") ? this.db.salaryAdvance.count({ where: { state: "PENDING", ...own }, take }) : none,
        decides("advancesToPay") ? this.db.salaryAdvance.count({ where: { state: "APPROVED", ...own }, take }) : none,
      ]);
    return { requests, disputes, certificates, profileChanges, dependents, advancesToDecide, advancesToPay };
  }

  /** The ledger: every state in the viewer's tree, newest first unless asked otherwise (KEHOACH 9.15). */
  async list(viewer: Viewer, query: ListRequestsDto): Promise<Page<RequestRow>> {
    const where = await this.ledgerWhere(viewer, query);
    return this.page(where, query.sort ?? "createdAt", query.order ?? "desc", query);
  }

  /** The ledger under the same filter, as a file Excel opens. */
  async exportCsv(viewer: Viewer, query: ListRequestsDto): Promise<string> {
    const field = query.sort ?? "createdAt";
    const rows = await this.withDeciders(
      await this.db.request.findMany({
        where: await this.ledgerWhere(viewer, query),
        orderBy: sortedBy(field, query.order ?? "desc") as Prisma.RequestOrderByWithRelationInput[],
        take: EXPORT_MAX,
        include: REQUEST_VIEW,
      }),
    );
    return toExcelCsv(
      EXPORT_COLUMNS,
      rows.map((row) => [
        row.employee.code,
        row.employee.fullName,
        row.employee.department?.name ?? "",
        row.kind,
        row.leaveType?.code ?? "",
        asDay(row.fromDate),
        asDay(row.toDate),
        row.days.toString(),
        row.state,
        row.reason,
        row.createdAt.toISOString(),
        row.decidedBy?.fullName ?? row.decidedBy?.email ?? "",
        row.decidedAt?.toISOString() ?? "",
        row.decisionNote ?? "",
      ]),
    );
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
      const claimed = await tx.request.updateMany({
        where: { id, state: "PENDING" },
        data: { state: "CANCELLED" },
      });
      if (claimed.count !== 1) {
        throw new ConflictException("REQUEST_ALREADY_DECIDED");
      }
      if (held.kind === "LEAVE" && held.leaveTypeId) {
        await this.release(tx, held);
      }
      return tx.request.findUniqueOrThrow({ where: { id } });
    });
  }

  private async ledgerWhere(viewer: Viewer, query: ListRequestsDto): Promise<Prisma.RequestWhereInput> {
    const visible = await this.scope.visibleEmployeeIds(viewer);
    const asked = query.employeeId;
    const whose =
      asked === undefined
        ? ScopeService.narrow("employeeId", visible)
        : { employeeId: visible === null || visible.includes(asked) ? asked : { in: [] } };
    return {
      AND: [whose, query.state ? { state: query.state } : {}, ...(await this.filters(query))],
    };
  }

  private async filters(query: ListRequestsDto): Promise<Prisma.RequestWhereInput[]> {
    const person = await personWhere(this.db, query);
    return [
      query.kind ? { kind: query.kind } : {},
      person ? { employee: person } : {},
      // Any overlap with the range, not containment: a leave crossing the first day is still in it.
      query.to ? { fromDate: { lte: new Date(query.to.slice(0, 10)) } } : {},
      query.from ? { toDate: { gte: new Date(query.from.slice(0, 10)) } } : {},
    ];
  }

  private async page(
    where: Prisma.RequestWhereInput,
    field: RequestSort,
    order: Order,
    query: ListRequestsDto,
  ): Promise<Page<RequestRow>> {
    const resumed = query.cursor
      ? { AND: [where, resumeAfter(field, order, query.cursor) as Prisma.RequestWhereInput] }
      : where;
    const [rows, found] = await Promise.all([
      this.db.request.findMany({
        where: resumed,
        orderBy: sortedBy(field, order) as Prisma.RequestOrderByWithRelationInput[],
        skip: query.cursor ? 0 : query.skip,
        take: query.take,
        include: REQUEST_VIEW,
      }),
      this.db.request.count({ where, take: COUNT_CEILING + 1 }),
    ]);
    return {
      rows: await this.withDeciders(rows),
      ...countedTo(found),
      next: nextCursor(rows, query.take, (row) => row[field]),
    };
  }

  /** Who decided each row, in one read for the page. */
  private async withDeciders(rows: Filed[]): Promise<RequestRow[]> {
    const ids = [...new Set(rows.map((row) => row.decidedById).filter((id): id is string => id !== null))];
    const users =
      ids.length === 0
        ? []
        : await this.db.user.findMany({
            where: { id: { in: ids } },
            select: { id: true, email: true, employee: { select: { fullName: true } } },
          });
    const byId = new Map(
      users.map((one) => [one.id, { id: one.id, email: one.email, fullName: one.employee?.fullName ?? null }]),
    );
    return rows.map((row) => ({ ...row, decidedBy: row.decidedById ? (byId.get(row.decidedById) ?? null) : null }));
  }

  /** How long each row waited, what leave is left once it is granted, and who else is off. */
  private async withContext(rows: RequestRow[]): Promise<InboxRow[]> {
    const leave = rows.filter((row) => row.kind === "LEAVE");
    const [after, overlaps] = await Promise.all([this.balancesAfter(leave), this.overlapCounts(leave)]);
    const now = new Date();
    return rows.map((row) => {
      const [first, second] = after.get(row.id) ?? [];
      return {
        ...row,
        waitedDays: waitedDays(row.createdAt, now),
        balanceAfter: first ?? null,
        nextBalanceAfter: second ?? null,
        overlapCount: row.kind === "LEAVE" ? (overlaps.get(row.id) ?? 0) : null,
      };
    });
  }

  // A waiting request already holds its days in `pending`, so what is free is what is left after it.
  private async balancesAfter(rows: RequestRow[]): Promise<Map<string, [number | undefined, number | undefined]>> {
    const keyed = rows.filter((row) => row.leaveTypeId !== null && row.leaveType?.paid !== false);
    if (keyed.length === 0) {
      return new Map();
    }
    const yearsOf = (row: RequestRow): number[] => {
      const year = row.fromDate.getUTCFullYear();
      return Number(row.nextYearDays) > 0 ? [year, year + 1] : [year];
    };
    const balances = await this.db.leaveBalance.findMany({
      where: {
        OR: keyed.flatMap((row) =>
          yearsOf(row).map((year) => ({ employeeId: row.employeeId, leaveTypeId: row.leaveTypeId as string, year })),
        ),
      },
    });
    const free = new Map(
      balances.map((one) => [`${one.employeeId}:${one.leaveTypeId}:${one.year}`, freeDays(one)]),
    );
    return new Map(
      keyed.map((row) => {
        const [first, second] = yearsOf(row).map((year) => free.get(`${row.employeeId}:${row.leaveTypeId}:${year}`));
        return [row.id, [first, second]];
      }),
    );
  }

  /** Teammates, meaning people under the same manager, off on overlapping dates: one query per page. */
  private async overlapCounts(rows: RequestRow[]): Promise<Map<string, number>> {
    if (rows.length === 0) {
      return new Map();
    }
    const found = await this.db.$queryRaw<{ id: string; n: number }[]>`
      SELECT r."id", COUNT(DISTINCT o."employeeId")::int AS "n"
        FROM "Request" r
        JOIN "Employee" e ON e."id" = r."employeeId"
        JOIN "Employee" mate ON mate."managerId" = e."managerId" AND mate."id" <> e."id" AND mate."active"
        JOIN "Request" o ON o."employeeId" = mate."id"
         AND o."kind" = 'LEAVE' AND o."state" IN ('PENDING', 'APPROVED')
         AND o."fromDate" <= r."toDate" AND o."toDate" >= r."fromDate"
       WHERE r."id" = ANY(${rows.map((row) => row.id)}::text[])
       GROUP BY r."id"
    `;
    return new Map(found.map((one) => [one.id, one.n]));
  }

  private async overlapping(held: LeaveRequest): Promise<Overlap[]> {
    const person = await this.db.employee.findUnique({
      where: { id: held.employeeId },
      select: { managerId: true },
    });
    if (!person?.managerId) {
      return [];
    }
    return this.db.request.findMany({
      where: {
        kind: "LEAVE",
        state: { in: OFF_WORK },
        employee: { managerId: person.managerId, id: { not: held.employeeId }, active: true },
        fromDate: { lte: held.toDate },
        toDate: { gte: held.fromDate },
      },
      select: { id: true, fromDate: true, toDate: true, state: true, employee: PERSON_VIEW },
      orderBy: [{ fromDate: "asc" }, { id: "asc" }],
      take: OVERLAP_SHOWN,
    });
  }

  /** Who a pending request waits on for this viewer; the inbox and the decision read the same rule. */
  private async waitingOnViewer(viewer: Viewer): Promise<Prisma.RequestWhereInput[]> {
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
    return mine;
  }

  /** Why this viewer may not decide a pending request, or null when they may. */
  private async refusal(
    viewer: Viewer,
    held: Pick<LeaveRequest, "employeeId" | "approverId">,
  ): Promise<"SELF_DECISION" | "NOT_YOUR_REQUEST" | null> {
    // No role decides its own request, the desk included (KEHOACH 9.4).
    if (held.employeeId === viewer.employeeId) {
      return "SELF_DECISION";
    }
    if (THE_DESK.includes(viewer.role)) {
      return null;
    }
    if (viewer.employeeId !== null && held.approverId !== null) {
      if (held.approverId === viewer.employeeId) {
        return null;
      }
      if ((await this.standingInFor(viewer.employeeId)).includes(held.approverId)) {
        return null;
      }
    }
    const visible = await this.scope.visibleEmployeeIds(viewer);
    return visible !== null && visible.includes(held.employeeId) ? null : "NOT_YOUR_REQUEST";
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
    const today = dayAsDate(this.timesheet.today());
    const rows = await this.db.approvalDelegation.findMany({
      where: { toId: employeeId, fromDate: { lte: today }, toDate: { gte: today } },
      select: { fromId: true },
    });
    return rows.map((row) => row.fromId);
  }

  /** Every year the request touches, or none: the caller's transaction rolls back a short second year. */
  private async hold(
    tx: Prisma.TransactionClient,
    employeeId: number,
    type: Pick<LeaveType, "id" | "paid">,
    parts: YearPart[],
  ): Promise<void> {
    for (const part of parts) {
      await this.years.ensure(tx, { employeeId, leaveTypeId: type.id }, part.year);
      // Check and hold in one statement: two filings reading the same balance would both pass a separate check.
      const held = await tx.$executeRaw`
        UPDATE "LeaveBalance"
           SET "pending" = "pending" + ${part.days}::numeric, "updatedAt" = now()
         WHERE "employeeId" = ${employeeId} AND "leaveTypeId" = ${type.id} AND "year" = ${part.year}
           AND (${!type.paid}::boolean
                OR "entitled" + "carriedOver" - "taken" - "pending" - "carriedOut" >= ${part.days}::numeric)
      `;
      if (held !== 1) {
        throw new ConflictException("LEAVE_BALANCE_SHORT");
      }
    }
  }

  private async settle(tx: Prisma.TransactionClient, held: LeaveRequest, approved: boolean): Promise<void> {
    for (const part of partsOf(held)) {
      await tx.leaveBalance.update({
        where: { employeeId_leaveTypeId_year: this.keyOf(held, part.year) },
        data: {
          pending: { decrement: part.days },
          ...(approved ? { taken: { increment: part.days } } : {}),
        },
      });
    }
  }

  private async release(tx: Prisma.TransactionClient, held: LeaveRequest): Promise<void> {
    for (const part of partsOf(held)) {
      await tx.leaveBalance.update({
        where: { employeeId_leaveTypeId_year: this.keyOf(held, part.year) },
        data: { pending: { decrement: part.days } },
      });
    }
  }

  private keyOf(held: LeaveRequest, year: number): { employeeId: number; leaveTypeId: string; year: number } {
    return { employeeId: held.employeeId, leaveTypeId: held.leaveTypeId as string, year };
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

function asDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}
