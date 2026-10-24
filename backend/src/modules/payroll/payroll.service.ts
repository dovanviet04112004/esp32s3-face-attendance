import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type {
  BonusItem,
  Payslip,
  PayslipLine,
  PayslipState,
  PayrollPeriod,
  PayrollRun,
  PeriodState,
  RunKind,
  RunState,
  SettlementKind,
} from "@prisma/client";
import { Prisma } from "@prisma/client";

import { toExcelCsv } from "../../common/csv.js";
import { COUNT_CEILING, countedTo } from "../../common/dto/cursor.dto.js";
import type { Page } from "../../common/dto/pagination.dto.js";
import { ScopeService } from "../../common/scope/scope.service.js";
import { refuseOwn, type Viewer } from "../../common/scope/viewer.js";
import type { Env } from "../../config/env.schema.js";
import { isPrismaCode, namedFilter, PrismaService, UNIQUE_VIOLATION } from "../../database/prisma.service.js";
import { QUEUE_TOKEN, type Queues } from "../../queue/queue.module.js";
import { JOB, QUEUE, type PayrollJob } from "../../queue/queues.js";
import { AUDIT_ACTIONS, AUDIT_SUBJECTS } from "../audit/audit-actions.js";
import { AuditService } from "../audit/audit.service.js";
import { freeDays } from "../leave/leave.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { AttendanceSweep } from "../notifications/sweeps/attendance.sweep.js";
import { asCalcPolicy, PolicyService } from "../policy/policy.service.js";
import { asDay, dayWindow, localDay } from "../timesheet/local-day.js";
import { calendarOn } from "../timesheet/timesheet.service.js";
import {
  calculate,
  taxOn,
  yearBrackets,
  CARRY_CODE,
  LINE_ASSET_OFFSET,
  LINE_CARRY_OUT,
  LINE_EXEMPT_OVERTIME,
  LINE_LEAVE_PAYOUT,
  LINE_RELIEF_DEPENDENT,
  LINE_RELIEF_SELF,
  LINE_SEVERANCE,
  LINE_TAX,
  type CalcAllowance,
  type CalcDeduction,
  type CalcExtra,
  type CalcPolicy,
} from "./calculate.js";
import type {
  BonusItemDto,
  CreatePeriodDto,
  CreateRunDto,
  ListPayslipsDto,
  LockPeriodDto,
  SettlementItemDto,
} from "./dto/payroll.dto.js";
import { atLeastZero, mulDiv, toDong, type Dong } from "./money.js";

const WRITERS: ReadonlySet<string> = new Set(["ADMIN", "PAYROLL"]);
const kChunk = 500;
const kHundred = 100n;
const kChunkTxMs = 60_000;
const LINE_ADVANCE = "ADVANCE";
// The reason a carried shortfall's adjustment names (KEHOACH 9.6).
const CARRY_REASON = "NEGATIVE_NET";

interface Leaver {
  id: number;
  code: string;
  fullName: string;
  leaveDate: Date | null;
  baseSalary: string;
  tenureMonths: number;
  legalEntityId: string;
}

/** Someone a run prices, with the entity whose policy prices them (KEHOACH 9.7). */
interface Priced {
  id: number;
  legalEntityId: string;
}

interface RunPolicy {
  id: string;
  calc: CalcPolicy;
}

export interface SettlementRow {
  employeeId: number;
  code: string;
  fullName: string;
  leaveDate: string | null;
  tenureMonths: number;
  baseSalary: string;
  halfMonthPay: string;
  unusedLeaveDays: number;
  leavePayout: string;
  assetsHeld: { code: string; name: string }[];
  typed: {
    kind: SettlementKind;
    label: string | null;
    amount: string;
    taxable: boolean;
    note: string | null;
  }[];
}

export interface SettlementSheet {
  runId: string;
  periodId: string;
  rows: SettlementRow[];
}

/** Entitlement plus what carried over, less what is taken or held. */
interface DayTally {
  employeeId: number;
  workedDays: number;
  holidayDays: number;
  absentDays: number;
  workedMinutes: number;
  weekdayOt: number;
  weekendOt: number;
  holidayOt: number;
}

interface LeaveTally {
  employeeId: number;
  paidLeaveHundredths: number;
  unpaidLeaveHundredths: number;
}

interface PayRow {
  employeeId: number;
  recordId: string;
  baseSalary: string;
  insuranceSalary: string;
}

export interface ChecklistItem {
  code: string;
  count: number;
}

export type PayslipDetail = Payslip & { lines: PayslipLine[] };

/** A payslip as a list shows it: the owner, the run's kind and the advance it recovered. */
export type PayslipRow = Payslip & {
  period: { year: number; month: number; state: PeriodState };
  employee: { id: number; code: string; fullName: string; department: { id: string; name: string } | null };
  run: { kind: RunKind; state: RunState };
  advance: string;
};

export interface HeldPunches {
  closedPeriod: number;
  late: number;
}

/** What a period costs, over the payslips it issues or will issue on lock. */
export interface PeriodTotals {
  payslips: number;
  people: number;
  gross: string;
  insuranceEmployee: string;
  insuranceEmployer: string;
  tax: string;
  net: string;
  employerCost: string;
}

/** The tax base a bonus or a settlement is charged on top of, per person. */
interface TaxBase {
  taxable: Dong;
  insurance: Dong;
}

/** The amounts a bonus run holds, with the person each belongs to. */
export type BonusRow = BonusItem & { employee: { id: number; code: string; fullName: string } };

/** How far a period's payslips have gone out: issued ones counted, sent ones among them. */
export interface Delivery {
  issued: number;
  sent: number;
}

export type ExportKind = "bank" | "ledger";

export interface PayslipDelta {
  code: string;
  thisPeriod: string;
  lastPeriod: string;
  difference: string;
}

/** One month of a year statement, every figure as the payslip holds it. */
export interface TaxYearMonth {
  periodId: string;
  month: number;
  grossPay: string;
  taxableIncome: string;
  insuranceEmployee: string;
  reliefSelf: string;
  reliefDependent: string;
  exemptOvertime: string;
  taxWithheld: string;
  netPay: string;
}

export interface TaxYearStatement {
  employeeId: number;
  code: string;
  fullName: string;
  taxCode: string | null;
  year: number;
  policyId: string;
  months: TaxYearMonth[];
  grossTotal: string;
  taxableTotal: string;
  insuranceTotal: string;
  reliefSelfTotal: string;
  reliefDependentTotal: string;
  exemptOvertimeTotal: string;
  assessableTotal: string;
  taxDue: string;
  taxWithheld: string;
  difference: string;
}

// A draft is a number nobody has stood behind, so it is not income yet.
const ISSUED_STATES: PayslipState[] = ["ISSUED", "SENT", "VIEWED"];
// A finished run whose base or inputs moved: its payslips go, the page says why (KEHOACH 9.6).
const BACK_TO_DRAFT = {
  state: "DRAFT",
  failure: "RUN_BASE_CHANGED",
  finishedAt: null,
  employeeCount: 0,
  doneCount: 0,
  failedCount: 0,
  grossTotal: 0,
  netTotal: 0,
} satisfies Prisma.PayrollRunUpdateManyMutationInput;
const READ_BACK = [LINE_RELIEF_SELF, LINE_RELIEF_DEPENDENT, LINE_EXEMPT_OVERTIME, LINE_TAX];

function monthIndex(month: { year: number; month: number }): number {
  return month.year * 12 + month.month;
}

/** Everyone a regular run of the period prices: its entity's people, the period's own leavers included. */
function coveredBy(period: PayrollPeriod): Prisma.EmployeeWhereInput {
  return {
    legalEntityId: period.legalEntityId,
    // `active` alone drops a mid-month leaver and the days they worked (KEHOACH 9.18.8).
    OR: [{ active: true }, { leaveDate: { gte: period.startDate } }],
  };
}

/** Payslip `s` is for someone a regular payslip of the same month already went to from another period (KEHOACH 9.6). */
function paidElsewhere(periodId: string): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1
      FROM "Payslip" o
      JOIN "PayrollRun" orun ON orun."id" = o."runId"
      JOIN "PayrollPeriod" op ON op."id" = o."periodId"
      JOIN "PayrollPeriod" here ON here."id" = ${periodId}
     WHERE o."employeeId" = s."employeeId" AND o."periodId" <> here."id"
       AND o."state" <> 'DRAFT' AND orun."kind" = 'REGULAR'
       AND op."year" = here."year" AND op."month" = here."month"
  )`;
}

/** The slips a limited desk reaches: its people's and its own, and every slip its entities' periods issued (KEHOACH 9.4). */
function slipsReached(viewer: Viewer): Prisma.PayslipWhereInput {
  const ids = viewer.entityIds;
  return ids === null ? {} : { OR: [ScopeService.ownedWhere(viewer, null), { period: { legalEntityId: { in: ids } } }] };
}

/** Working days of the period outside somebody's hire and leave dates, by the timesheet's one calendar (KEHOACH 9.5, 9.7). */
function workdaysOutside(
  period: PayrollPeriod,
  person: { legalEntityId: string; hireDate: Date | null; leaveDate: Date | null },
  holidays: readonly { date: Date; legalEntityId: string | null; paid: boolean }[],
): number {
  let days = 0;
  for (let at = new Date(period.startDate); at <= period.endDate; at.setUTCDate(at.getUTCDate() + 1)) {
    const outside = (person.hireDate !== null && at < person.hireDate) || (person.leaveDate !== null && at > person.leaveDate);
    const declared = holidays.filter((one) => one.date.getTime() === at.getTime());
    if (outside && calendarOn(at, declared, person.legalEntityId) === "WORKDAY") {
      days += 1;
    }
  }
  return days;
}

/** Day hundredths as the Decimal(6,2) a payslip's day columns hold; halves stay exact. */
function daysOf(hundredths: number): string {
  return (hundredths / 100).toFixed(2);
}

function sumOf(lines: { code: string; amount: Prisma.Decimal }[], code: string): Dong {
  return lines
    .filter((line) => line.code === code)
    .reduce((total, line) => total + toDong(line.amount), 0n);
}

const PAYSLIP_ROW = {
  period: { select: { year: true, month: true, state: true } },
  employee: {
    select: { id: true, code: true, fullName: true, department: { select: { id: true, name: true } } },
  },
  run: { select: { kind: true, state: true } },
  lines: { where: { code: LINE_ADVANCE }, select: { code: true, amount: true } },
} satisfies Prisma.PayslipInclude;

type PayslipWithRow = Prisma.PayslipGetPayload<{ include: typeof PAYSLIP_ROW }>;

function asPayslipRow(row: PayslipWithRow): PayslipRow {
  const { lines, ...rest } = row;
  return { ...rest, advance: sumOf(lines, LINE_ADVANCE).toString() };
}

@Injectable()
export class PayrollService {
  constructor(
    private readonly db: PrismaService,
    private readonly scope: ScopeService,
    private readonly policy: PolicyService,
    private readonly audit: AuditService,
    private readonly notices: NotificationsService,
    private readonly attendance: AttendanceSweep,
    @Inject(QUEUE_TOKEN) private readonly queues: Queues,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** The business day now, which decides whether a month has begun or ended (KEHOACH 9.6, 9.8). */
  private today(): string {
    return localDay(new Date(), this.config.get("APP_TIMEZONE", { infer: true }));
  }

  private mayWrite(viewer: Viewer): void {
    if (!WRITERS.has(viewer.role)) {
      throw new ForbiddenException("PAYROLL_WRITE_DENIED");
    }
  }

  periods(viewer: Viewer, legalEntityId?: string): Promise<PayrollPeriod[]> {
    return this.db.payrollPeriod.findMany({
      where: { ...(legalEntityId ? { legalEntityId } : {}), ...ScopeService.entityWhere(viewer, false) },
      orderBy: [{ year: "desc" }, { month: "desc" }],
    });
  }

  /** Punches of the period's days waiting on review, counted by hold reason (KEHOACH 9.8). */
  async heldPunches(viewer: Viewer, periodId: string): Promise<HeldPunches> {
    const period = await this.periodOf(viewer, periodId);
    const zone = this.config.get("APP_TIMEZONE", { infer: true });
    const rows = await this.db.attendanceRecord.groupBy({
      by: ["hold"],
      where: {
        review: "PENDING",
        ts: { gte: dayWindow(asDay(period.startDate), zone).from, lt: dayWindow(asDay(period.endDate), zone).to },
        ...(period.legalEntityId ? { employee: { legalEntityId: period.legalEntityId } } : {}),
      },
      _count: { _all: true },
    });
    const countOf = (hold: string) => rows.find((row) => row.hold === hold)?._count._all ?? 0;
    return { closedPeriod: countOf("CLOSED_PERIOD"), late: countOf("LATE") };
  }

  /** Open one entity's month: one open period an entity at a time, months only forward (KEHOACH 9.6). */
  async createPeriod(viewer: Viewer, body: CreatePeriodDto): Promise<PayrollPeriod> {
    this.mayWrite(viewer);
    if (`${body.year}-${String(body.month).padStart(2, "0")}-01` > this.today()) {
      throw new BadRequestException("PERIOD_NOT_STARTED");
    }
    const legalEntityId = await this.entityToPay(viewer, body.legalEntityId);
    const asked = monthIndex(body);
    try {
      return await this.db.$transaction(async (tx) => {
        // Two presses for one entity queue on its row, so the second sees the period the first made.
        await tx.$queryRaw`SELECT "id" FROM "LegalEntity" WHERE "id" = ${legalEntityId} FOR NO KEY UPDATE`;
        const held = await tx.payrollPeriod.findMany({
          where: { legalEntityId },
          select: { year: true, month: true, state: true },
        });
        if (held.some((one) => monthIndex(one) === asked)) {
          throw new ConflictException("PERIOD_TAKEN");
        }
        if (held.some((one) => one.state === "OPEN")) {
          throw new ConflictException("PERIOD_STILL_OPEN");
        }
        if (held.some((one) => monthIndex(one) > asked)) {
          throw new ConflictException("PERIOD_OUT_OF_ORDER");
        }
        return tx.payrollPeriod.create({
          data: {
            legalEntityId,
            year: body.year,
            month: body.month,
            startDate: new Date(Date.UTC(body.year, body.month - 1, 1)),
            endDate: new Date(Date.UTC(body.year, body.month, 0)),
            payDate: body.payDate ? new Date(body.payDate) : null,
          },
        });
      });
    } catch (error) {
      if (isPrismaCode(error, UNIQUE_VIOLATION)) {
        throw new ConflictException("PERIOD_TAKEN");
      }
      throw error;
    }
  }

  /** The entity a new period pays: the one named, else the only one in use the viewer answers for (KEHOACH 9.4, 9.6). */
  private async entityToPay(viewer: Viewer, named?: string): Promise<string> {
    if (named) {
      const entity = await this.db.legalEntity.findUnique({ where: { id: named }, select: { active: true } });
      if (!entity?.active || !ScopeService.reachesEntity(viewer, named)) {
        throw new NotFoundException("LEGAL_ENTITY_NOT_FOUND");
      }
      return named;
    }
    const reached = viewer.entityIds === null ? {} : { id: { in: viewer.entityIds } };
    const inUse = await this.db.legalEntity.findMany({ where: { active: true, ...reached }, select: { id: true }, take: 2 });
    if (inUse.length !== 1) {
      throw new BadRequestException("LEGAL_ENTITY_REQUIRED");
    }
    return inUse[0].id;
  }

  /**
   * What is still unsettled in a period. Locking over an open item is allowed
   * but names who accepted it, so the decision has an owner (KEHOACH 9.18).
   */
  async checklist(periodId: string): Promise<ChecklistItem[]> {
    const period = await this.requirePeriod(periodId);
    const legalEntityId = period.legalEntityId;
    const ofEntity = { employee: { legalEntityId } };
    // Somebody hired after the period owes it neither a pay record nor a built day (KEHOACH 9.8).
    const hired = { OR: [{ hireDate: null }, { hireDate: { lte: period.endDate } }] } satisfies Prisma.EmployeeWhereInput;
    const [
      pendingRequests,
      missingPay,
      payChanges,
      unbuiltDays,
      openCorrections,
      notInRun,
      paidElsewhere,
      stillHolding,
      lateDisputes,
      comingShort,
    ] = await Promise.all([
      this.db.request.count({
        where: {
          state: "PENDING",
          fromDate: { lte: period.endDate },
          toDate: { gte: period.startDate },
          ...ofEntity,
        },
      }),
      this.db.employee.count({
        where: {
          active: true,
          legalEntityId,
          ...hired,
          compensation: { none: { effectiveFrom: { lte: period.endDate } } },
        },
      }),
      this.db.compensationRecord.count({
        where: { effectiveFrom: { gte: period.startDate, lte: period.endDate }, ...ofEntity },
      }),
      this.db.employee.count({
        where: {
          active: true,
          legalEntityId,
          ...hired,
          days: { none: { date: { gte: period.startDate, lte: period.endDate } } },
        },
      }),
      this.db.request.count({
        where: {
          kind: "ATTENDANCE_FIX",
          state: "PENDING",
          fromDate: { lte: period.endDate },
          toDate: { gte: period.startDate },
          ...ofEntity,
        },
      }),
      // Hired or moved in after the newest regular run: a lock would leave them unpaid without a word.
      this.db.employee.count({
        where: {
          ...coveredBy(period),
          compensation: { some: { effectiveFrom: { lte: period.endDate } } },
          payslips: { none: { periodId, run: { kind: "REGULAR", state: "DONE" } } },
        },
      }),
      this.paidElsewhereCount(periodId),
      // A leaver still holding an asset: the last payslip is the last chance to deduct it (KEHOACH 9.16 item 10).
      this.db.employee.count({
        where: {
          leaveDate: { gte: period.startDate, lte: period.endDate },
          legalEntityId,
          assetsHeld: { some: { state: "ISSUED" } },
        },
      }),
      // Overdue disputes, so a missed deadline costs somebody a signature (KEHOACH 9.17 item 11).
      this.db.payslipDispute.count({
        where: {
          state: "OPEN",
          dueAt: { lt: new Date() },
          payslip: { period: { legalEntityId } },
        },
      }),
      this.comingShortCount(periodId),
    ]);
    return [
      { code: "REQUESTS_PENDING", count: pendingRequests },
      { code: "CORRECTIONS_OPEN", count: openCorrections },
      { code: "NO_COMPENSATION", count: missingPay },
      { code: "PAY_CHANGES", count: payChanges },
      { code: "NO_ATTENDANCE_DAYS", count: unbuiltDays },
      { code: "NOT_IN_RUN", count: notInRun },
      { code: "PAID_ELSEWHERE", count: paidElsewhere },
      { code: "LEAVERS_HOLDING_ASSETS", count: stillHolding },
      { code: "DISPUTES_OVERDUE", count: lateDisputes },
      { code: "NEGATIVE_NET", count: comingShort },
    ];
  }

  /** Payslips the lock would issue that come short: carried to the next period, or left owing by a leaver. */
  private async comingShortCount(periodId: string): Promise<number> {
    const [row] = await this.db.$queryRaw<{ count: number }[]>`
      WITH chosen AS (${this.chosenSlips(periodId)})
      SELECT count(*)::int AS "count"
        FROM "Payslip" p
        JOIN chosen c ON c."id" = p."id"
       WHERE p."netPay" < 0
          OR EXISTS (SELECT 1 FROM "PayslipLine" l WHERE l."payslipId" = p."id" AND l."code" = ${LINE_CARRY_OUT})
    `;
    return row?.count ?? 0;
  }

  /** How many of this period's regular payslips belong to someone a regular payslip for the month already went to. */
  private async paidElsewhereCount(periodId: string): Promise<number> {
    const [row] = await this.db.$queryRaw<{ count: number }[]>`
      SELECT count(DISTINCT s."employeeId")::int AS "count"
        FROM "Payslip" s
        JOIN "PayrollRun" r ON r."id" = s."runId"
       WHERE s."periodId" = ${periodId} AND r."state" = 'DONE' AND r."kind" = 'REGULAR'
         AND ${paidElsewhere(periodId)}
    `;
    return row?.count ?? 0;
  }

  async lock(viewer: Viewer, periodId: string, body: LockPeriodDto): Promise<PayrollPeriod> {
    this.mayWrite(viewer);
    const period = await this.periodOf(viewer, periodId);
    if (period.state !== "OPEN") {
      throw new BadRequestException("PERIOD_NOT_OPEN");
    }
    if (asDay(period.endDate) >= this.today()) {
      throw new BadRequestException("PERIOD_NOT_ENDED");
    }
    await this.requireRunsSettled(this.db, periodId);
    const open = (await this.checklist(periodId)).filter((item) => item.count > 0);
    if (open.length > 0 && !body.acceptOpenItems) {
      throw new BadRequestException("CHECKLIST_NOT_CLEAR");
    }
    if (open.length > 0 && !body.note?.trim()) {
      throw new BadRequestException("LOCK_NOTE_REQUIRED");
    }
    // Issuing and spending are one act, or a period closes with its back payments still owed.
    const locked = await this.db.$transaction(
      async (tx) => {
        // The row lock execute and discard take too, so no run starts or goes between the check and the lock.
        await tx.$queryRaw`SELECT "id" FROM "PayrollPeriod" WHERE "id" = ${periodId} FOR NO KEY UPDATE`;
        await this.requireRunsSettled(tx, periodId);
        const shut = await tx.payrollPeriod.updateMany({
          where: { id: periodId, state: "OPEN" },
          data: {
            state: "LOCKED",
            lockedAt: new Date(),
            lockedById: viewer.userId,
            lockNote: body.note?.trim() || null,
          },
        });
        if (shut.count === 0) {
          throw new BadRequestException("PERIOD_NOT_OPEN");
        }
        await tx.$executeRaw`
          WITH chosen AS (${this.chosenSlips(periodId)})
          UPDATE "Payslip" p
             SET "state" = 'ISSUED', "issuedAt" = now(), "updatedAt" = now()
            FROM chosen c
           WHERE p."id" = c."id" AND p."state" = 'DRAFT'
        `;
        // Where the money lands is an input too, and locking freezes inputs (KEHOACH 9.6).
        await tx.$executeRaw`
          UPDATE "Payslip" p
             SET "bankName" = e."bankName", "bankAccount" = e."bankAccount"
            FROM "Employee" e
           WHERE p."periodId" = ${periodId}
             AND p."state" <> 'DRAFT'
             AND p."employeeId" = e."id"
        `;
        // Only what an issued payslip carried is spent; the rest waits for the next period.
        await tx.$executeRaw`
          UPDATE "RetroAdjustment" a
             SET "state" = 'APPLIED'
            FROM "Payslip" p
            JOIN "PayrollRun" r ON r."id" = p."runId"
           WHERE p."periodId" = ${periodId}
             AND p."state" <> 'DRAFT'
             AND r."kind" = 'REGULAR'
             AND p."employeeId" = a."employeeId"
             AND a."state" = 'PENDING'
             AND a."appliedPeriodId" = ${periodId}
             AND EXISTS (
               SELECT 1 FROM "PayslipLine" l
                WHERE l."payslipId" = p."id" AND l."code" = 'RETRO_' || a."code"
             )
        `;
        await tx.$executeRaw`
          INSERT INTO "RetroAdjustment" ("id", "employeeId", "sourcePeriodId", "code", "amount", "reason", "createdById")
          SELECT gen_random_uuid()::text, p."employeeId", ${periodId}, ${CARRY_CODE}, l."amount", ${CARRY_REASON},
                 ${viewer.userId}
            FROM "Payslip" p
            JOIN "PayrollRun" r ON r."id" = p."runId"
            JOIN "PayslipLine" l ON l."payslipId" = p."id" AND l."code" = ${LINE_CARRY_OUT}
           WHERE p."periodId" = ${periodId}
             AND p."state" <> 'DRAFT'
             AND r."kind" = 'REGULAR'
        `;
        await tx.$executeRaw`
          UPDATE "SalaryAdvance" a
             SET "state" = 'SETTLED', "settledAt" = now()
            FROM "Payslip" p
           WHERE p."periodId" = ${periodId}
             AND p."state" <> 'DRAFT'
             AND a."payslipId" = p."id"
             AND a."state" = 'PAID'
        `;
        return tx.payrollPeriod.findUniqueOrThrow({ where: { id: periodId } });
      },
      { timeout: kChunkTxMs },
    );
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.PAYROLL_LOCK,
      subject: AUDIT_SUBJECTS.PAYROLL,
      subjectId: periodId,
      meta: { openItems: open.map((item) => item.code), note: locked.lockNote },
    });
    // Bonus and final runs stand on the regular slip (KEHOACH 9.18), so the oldest is the one to open.
    const told = await this.db.payslip.findMany({
      where: { periodId, state: "ISSUED" },
      select: { id: true, employeeId: true },
      orderBy: [{ employeeId: "asc" }, { createdAt: "asc" }],
      distinct: ["employeeId"],
    });
    await this.notices.raiseEachFor(
      "PAYSLIP_ISSUED",
      told.map((row) => ({ employeeId: row.employeeId, facts: { periodId, payslipId: row.id } })),
    );
    const month = `${period.year}-${String(period.month).padStart(2, "0")}`;
    await this.notices.raiseEachFor(
      "TIMESHEET_MONTH_CLOSED",
      told.map((row) => ({ employeeId: row.employeeId, facts: { periodId, month } })),
    );
    await this.attendance.closeVanished();
    return locked;
  }

  /** A lock needs no run going, the newest regular run done, and every bonus or settlement done or discarded (KEHOACH 9.6). */
  private async requireRunsSettled(client: Prisma.TransactionClient, periodId: string): Promise<void> {
    const runs = await client.payrollRun.findMany({
      where: { periodId, state: { not: "DISCARDED" } },
      select: { id: true, kind: true, state: true, failure: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
    if (runs.some((run) => run.state === "RUNNING")) {
      throw new ConflictException("PERIOD_RUN_IN_PROGRESS");
    }
    const newestRegular = runs.find((run) => run.kind === "REGULAR");
    const unfinished = runs.filter(
      (run) => run.state !== "DONE" && (run.kind !== "REGULAR" || run.id === newestRegular?.id),
    );
    if (unfinished.some((run) => run.failure === "RUN_BASE_CHANGED")) {
      throw new ConflictException("RUN_BASE_CHANGED");
    }
    if (unfinished.length > 0) {
      throw new ConflictException("PERIOD_RUNS_UNFINISHED");
    }
  }

  async markPaid(viewer: Viewer, periodId: string): Promise<PayrollPeriod> {
    this.mayWrite(viewer);
    const period = await this.periodOf(viewer, periodId);
    if (period.state !== "LOCKED") {
      throw new BadRequestException("PERIOD_NOT_LOCKED");
    }
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.PAYROLL_PAID,
      subject: AUDIT_SUBJECTS.PAYROLL,
      subjectId: periodId,
    });
    return this.db.payrollPeriod.update({
      where: { id: periodId },
      data: { state: "PAID", paidAt: new Date() },
    });
  }

  async runs(viewer: Viewer, periodId: string): Promise<PayrollRun[]> {
    await this.periodOf(viewer, periodId);
    return this.db.payrollRun.findMany({ where: { periodId }, orderBy: { createdAt: "desc" } });
  }

  /** The checklist of a period the viewer answers for. */
  async checklistFor(viewer: Viewer, periodId: string): Promise<ChecklistItem[]> {
    await this.periodOf(viewer, periodId);
    return this.checklist(periodId);
  }

  async createRun(viewer: Viewer, body: CreateRunDto): Promise<PayrollRun> {
    this.mayWrite(viewer);
    await this.periodOf(viewer, body.periodId);
    return this.db.$transaction(async (tx) => {
      await this.requireOpen(tx, body.periodId);
      return tx.payrollRun.create({
        data: {
          periodId: body.periodId,
          kind: body.kind,
          label: body.label ?? null,
          departmentId: body.departmentId ?? null,
          createdById: viewer.userId,
          note: body.note ?? null,
        },
      });
    });
  }

  /**
   * Calculate every payslip in a run. Overtime pays the lesser of the measured
   * minutes and the approved ones for that day (KEHOACH 9.17), and the inputs
   * are six grouped queries rather than one per person (KEHOACH 9.9).
   */
  async execute(viewer: Viewer, runId: string): Promise<PayrollRun> {
    this.mayWrite(viewer);
    const run = await this.requireRunnable(viewer, runId);
    if (run.kind === "BONUS") {
      // Answer here rather than queueing a job that cannot succeed.
      await this.requireBonusReady(run.id, run.periodId);
    }
    if (run.kind === "FINAL_SETTLEMENT") {
      await this.requireSettlementReady(run.period);
    }
    // Someone priced with no policy in force stops the whole run, so the press says so (KEHOACH 9.6).
    await this.policiesFor(run.period, await this.pricedBy(run));
    // Claimed under the period's row lock, which lock and discard take too, so a period runs one run at a time.
    const claimed = await this.db.$transaction(async (tx) => {
      const [period] = await tx.$queryRaw<{ state: PeriodState }[]>`
        SELECT "state" FROM "PayrollPeriod" WHERE "id" = ${run.periodId} FOR NO KEY UPDATE
      `;
      if (period?.state !== "OPEN") {
        throw new BadRequestException("PERIOD_NOT_OPEN");
      }
      const { state } = await tx.payrollRun.findUniqueOrThrow({ where: { id: run.id }, select: { state: true } });
      if (state === "DISCARDED") {
        throw new ConflictException("RUN_DISCARDED");
      }
      if (state === "RUNNING") {
        return false;
      }
      if ((await tx.payrollRun.count({ where: { periodId: run.periodId, state: "RUNNING" } })) > 0) {
        throw new ConflictException("PERIOD_RUN_IN_PROGRESS");
      }
      await tx.payrollRun.update({
        where: { id: run.id },
        data: { state: "RUNNING", startedAt: new Date(), finishedAt: null, doneCount: 0, failedCount: 0, failure: null },
      });
      return true;
    });
    if (!claimed) {
      throw new BadRequestException("RUN_ALREADY_RUNNING");
    }
    try {
      // BullMQ keeps completed jobs, so a run-derived job id would make a rerun a no-op; RUNNING stops a double start.
      await this.queues[QUEUE.payroll].add(JOB.run, { type: JOB.run, runId } satisfies PayrollJob);
    } catch (error) {
      await this.db.payrollRun.update({ where: { id: run.id }, data: { state: "FAILED", finishedAt: new Date() } });
      throw error;
    }
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.PAYROLL_QUEUE,
      subject: AUDIT_SUBJECTS.PAYROLL,
      subjectId: runId,
    });
    return this.db.payrollRun.findUniqueOrThrow({ where: { id: run.id } });
  }

  private async requireRunnable(viewer: Viewer, runId: string): Promise<PayrollRun & { period: PayrollPeriod }> {
    const run = await this.runOf(viewer, runId);
    if (run.period.state !== "OPEN") {
      throw new BadRequestException("PERIOD_NOT_OPEN");
    }
    if (run.state === "RUNNING") {
      throw new BadRequestException("RUN_ALREADY_RUNNING");
    }
    if (run.state === "DISCARDED") {
      throw new ConflictException("RUN_DISCARDED");
    }
    return run;
  }

  /** Take a run of an open period out for good: its payslips go, and a finished regular one sends
   *  the period's other finished runs back to draft (KEHOACH 9.6).
   */
  async discard(viewer: Viewer, runId: string): Promise<PayrollRun> {
    this.mayWrite(viewer);
    const found = await this.runOf(viewer, runId);
    const { run, was } = await this.db.$transaction(async (tx) => {
      const [period] = await tx.$queryRaw<{ state: PeriodState }[]>`
        SELECT "state" FROM "PayrollPeriod" WHERE "id" = ${found.periodId} FOR NO KEY UPDATE
      `;
      if (period?.state !== "OPEN") {
        throw new BadRequestException("PERIOD_NOT_OPEN");
      }
      const held = await tx.payrollRun.findUniqueOrThrow({ where: { id: runId } });
      if (held.state === "RUNNING") {
        throw new BadRequestException("RUN_ALREADY_RUNNING");
      }
      if (held.state === "DISCARDED") {
        throw new ConflictException("RUN_DISCARDED");
      }
      if (held.kind === "REGULAR" && held.state === "DONE") {
        await this.staleOver(tx, held.periodId, ["REGULAR", "BONUS", "FINAL_SETTLEMENT"], runId);
      }
      await this.dropSlips(tx, [runId]);
      return {
        run: await tx.payrollRun.update({
          where: { id: runId },
          data: { state: "DISCARDED", failure: null, doneCount: 0, failedCount: 0, grossTotal: 0, netTotal: 0 },
        }),
        was: held.state,
      };
    });
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.PAYROLL_DISCARD,
      subject: AUDIT_SUBJECTS.PAYROLL,
      subjectId: runId,
      meta: { kind: run.kind, state: was },
    });
    return run;
  }

  /** Send a period's finished runs of these kinds back to draft: payslips go, inputs stay (KEHOACH 9.6). */
  private async staleOver(
    tx: Prisma.TransactionClient,
    periodId: string,
    kinds: RunKind[],
    except?: string,
  ): Promise<void> {
    const stale = await tx.payrollRun.findMany({
      where: { periodId, kind: { in: kinds }, state: "DONE", ...(except ? { id: { not: except } } : {}) },
      select: { id: true },
    });
    if (stale.length === 0) {
      return;
    }
    const ids = stale.map((one) => one.id);
    await this.dropSlips(tx, ids);
    await tx.payrollRun.updateMany({ where: { id: { in: ids } }, data: BACK_TO_DRAFT });
  }

  /** Hold the period's row for the rest of the transaction, as execute, discard and lock do, and refuse a closed one. */
  private async requireOpen(tx: Prisma.TransactionClient, periodId: string): Promise<void> {
    const [period] = await tx.$queryRaw<{ state: PeriodState }[]>`
      SELECT "state" FROM "PayrollPeriod" WHERE "id" = ${periodId} FOR NO KEY UPDATE
    `;
    if (period?.state !== "OPEN") {
      throw new BadRequestException("PERIOD_NOT_OPEN");
    }
  }

  /** Swap what a bonus or settlement run pays while its period is open; a finished run goes back to draft (KEHOACH 9.6). */
  private async reload(
    runId: string,
    periodId: string,
    swap: (tx: Prisma.TransactionClient) => Promise<unknown>,
  ): Promise<void> {
    await this.db.$transaction(async (tx) => {
      await this.requireOpen(tx, periodId);
      const { state } = await tx.payrollRun.findUniqueOrThrow({ where: { id: runId }, select: { state: true } });
      if (state === "RUNNING") {
        throw new BadRequestException("RUN_ALREADY_RUNNING");
      }
      if (state === "DISCARDED") {
        throw new ConflictException("RUN_DISCARDED");
      }
      await swap(tx);
      if (state !== "DONE") {
        return;
      }
      await this.dropSlips(tx, [runId]);
      const stale = await tx.payrollRun.updateMany({ where: { id: runId, state: "DONE" }, data: BACK_TO_DRAFT });
      if (stale.count === 0) {
        throw new ConflictException("RUN_BASE_CHANGED");
      }
    });
  }

  /** Delete runs' payslips, and let go of the advances they deducted for the next regular run to carry. */
  private async dropSlips(tx: Prisma.TransactionClient, runIds: string[]): Promise<void> {
    await tx.$executeRaw`
      UPDATE "SalaryAdvance" a
         SET "payslipId" = NULL
        FROM "Payslip" p
       WHERE p."runId" = ANY(${runIds}::text[]) AND a."payslipId" = p."id" AND a."state" = 'PAID'
    `;
    await tx.payslip.deleteMany({ where: { runId: { in: runIds } } });
  }

  /** The work itself, called by the worker. A second delivery of the same job
   *  recomputes the same run rather than doubling it.
   */
  async runNow(runId: string): Promise<PayrollRun> {
    const ended = await this.computeRun(runId);
    await this.tellEnded(ended);
    return ended;
  }

  /** Close a run the worker gave up on as failed with the code that stopped it, and tell whoever pressed it. */
  async failRun(runId: string, failure: string): Promise<PayrollRun> {
    const failed = await this.db.payrollRun.update({
      where: { id: runId },
      data: { state: "FAILED", finishedAt: new Date(), failure },
    });
    await this.tellEnded(failed);
    return failed;
  }

  private async tellEnded(run: PayrollRun): Promise<void> {
    if (run.createdById === null) {
      return;
    }
    await this.notices.raise(run.createdById, "PAYROLL_RUN_DONE", {
      runId: run.id,
      periodId: run.periodId,
      failed: run.state !== "DONE",
      payslips: run.doneCount,
      finishedAt: (run.finishedAt ?? new Date()).getTime(),
    });
  }

  private async computeRun(runId: string): Promise<PayrollRun> {
    const run = await this.db.payrollRun.findUnique({
      where: { id: runId },
      include: { period: true },
    });
    if (!run) {
      throw new NotFoundException("RUN_NOT_FOUND");
    }
    // A lock that landed while the job sat in the queue wins: a locked period takes no new drafts.
    if (run.period.state !== "OPEN") {
      return this.db.payrollRun.update({
        where: { id: runId },
        data: { state: "FAILED", finishedAt: new Date(), failure: "PERIOD_NOT_OPEN" },
      });
    }

    const period = run.period;
    if (run.kind === "BONUS") {
      return this.runBonus(run.id, period);
    }
    if (run.kind === "FINAL_SETTLEMENT") {
      return this.runSettlement(run.id, period);
    }

    const people = await this.pricedBy(run);
    const policyOf = await this.policiesFor(period, people);
    const ids = people.map((person) => person.id);

    await this.db.payrollRun.update({
      where: { id: runId },
      data: { state: "RUNNING", startedAt: new Date(), employeeCount: ids.length, doneCount: 0, failedCount: 0, failure: null },
    });
    // A rerun of a draft recomputes: one payslip per person per run, whatever an earlier attempt left.
    await this.db.payslip.deleteMany({ where: { runId } });

    let grossTotal = 0n;
    let netTotal = 0n;
    let done = 0;
    const retroIds: string[] = [];
    const advanceIds: string[] = [];

    for (let at = 0; at < ids.length; at += kChunk) {
      const slice = ids.slice(at, at + kChunk);
      const result = await this.runChunk(runId, period, policyOf, slice);
      grossTotal += result.gross;
      netTotal += result.net;
      done += result.done;
      retroIds.push(...result.retroIds);
      advanceIds.push(...result.advanceIds);
      await this.db.payrollRun.update({ where: { id: runId }, data: { doneCount: done } });
    }

    await this.audit.record({
      actorId: run.createdById ?? undefined,
      action: AUDIT_ACTIONS.PAYROLL_RUN,
      subject: AUDIT_SUBJECTS.PAYROLL,
      subjectId: runId,
      meta: { employees: ids.length, payslips: done },
    });
    // Linked as the run finishes, so a run that never finishes claims nothing the lock settles.
    return this.db.$transaction(async (tx) => {
      await this.markCarried(tx, runId, period.id, retroIds, advanceIds);
      await this.staleOver(tx, period.id, ["BONUS", "FINAL_SETTLEMENT"]);
      return tx.payrollRun.update({
        where: { id: runId },
        data: {
          state: "DONE",
          finishedAt: new Date(),
          doneCount: done,
          failedCount: ids.length - done,
          grossTotal: grossTotal.toString(),
          netTotal: netTotal.toString(),
        },
      });
    });
  }

  private async runChunk(
    runId: string,
    period: PayrollPeriod,
    policyOf: ReadonlyMap<number, RunPolicy>,
    ids: number[],
  ): Promise<{ gross: Dong; net: Dong; done: number; retroIds: string[]; advanceIds: string[] }> {
    const [pay, allowances, days, leave, dependents, retros, advances, people, holidays] = await Promise.all([
      this.db.$queryRaw<PayRow[]>`
        SELECT DISTINCT ON (c."employeeId")
               c."employeeId", c."id" AS "recordId",
               c."baseSalary"::text, c."insuranceSalary"::text
          FROM "CompensationRecord" c
         WHERE c."employeeId" = ANY(${ids}::int[]) AND c."effectiveFrom" <= ${period.endDate}
         ORDER BY c."employeeId", c."effectiveFrom" DESC
      `,
      this.db.$queryRaw<
        {
          recordId: string;
          code: string;
          label: string;
          amount: string;
          taxable: boolean;
          insurable: boolean;
          taxFreeCap: string | null;
        }[]
      >`
        SELECT a."recordId", a."code", a."label", a."amount"::text, a."taxable", a."insurable",
               a."taxFreeCap"::text
          FROM "CompensationAllowance" a
          JOIN "CompensationRecord" c ON c."id" = a."recordId"
         WHERE c."employeeId" = ANY(${ids}::int[]) AND c."effectiveFrom" <= ${period.endDate}
      `,
      this.db.$queryRaw<DayTally[]>`
        WITH paid AS (
          SELECT d."employeeId", d."state", d."calendar", d."workedMinutes",
                 (d."date" < coalesce(e."hireDate", d."date") OR d."date" > coalesce(e."leaveDate", d."date")) AS "outside",
                 LEAST(d."overtimeMinutes", floor(coalesce(a."allowed", 0))::int) AS "overtimePaid"
            FROM "AttendanceDay" d
            JOIN "Employee" e ON e."id" = d."employeeId"
            LEFT JOIN LATERAL (
              SELECT sum(r."minutes"::numeric / (r."toDate"::date - r."fromDate"::date + 1)) AS "allowed"
                FROM "Request" r
               WHERE r."employeeId" = d."employeeId"
                 AND r."kind" = 'OVERTIME' AND r."state" = 'APPROVED'
                 AND d."date" BETWEEN r."fromDate" AND r."toDate"
            ) a ON true
           WHERE d."employeeId" = ANY(${ids}::int[])
             AND d."date" BETWEEN ${period.startDate} AND ${period.endDate}
        )
        -- A day off worked is paid as overtime alone; a paid holiday is paid whether worked or not.
        -- A day outside the employment dates is counted from the calendar instead, so never twice.
        SELECT "employeeId",
               count(*) FILTER (WHERE "state" = 'WORKED' AND "calendar" = 'WORKDAY')::int AS "workedDays",
               count(*) FILTER (WHERE "calendar" = 'HOLIDAY')::int                        AS "holidayDays",
               count(*) FILTER (WHERE "state" = 'ABSENT' AND NOT "outside")::int          AS "absentDays",
               coalesce(sum("workedMinutes"), 0)::int                                     AS "workedMinutes",
               coalesce(sum("overtimePaid") FILTER (WHERE "calendar" = 'WORKDAY'), 0)::int AS "weekdayOt",
               coalesce(sum("overtimePaid") FILTER (WHERE "calendar" IN ('WEEKEND', 'UNPAID_HOLIDAY')), 0)::int
                 AS "weekendOt",
               coalesce(sum("overtimePaid") FILTER (WHERE "calendar" = 'HOLIDAY'), 0)::int AS "holidayOt"
          FROM paid
         GROUP BY "employeeId"
      `,
      this.db.$queryRaw<LeaveTally[]>`
        -- A day of leave can be two approved halves, each of its own type and worth half a day (KEHOACH 9.5).
        SELECT d."employeeId",
               coalesce(sum(CASE WHEN r."halfDay" THEN 50 ELSE 100 END) FILTER (WHERE t."paid"), 0)::int
                 AS "paidLeaveHundredths",
               coalesce(sum(CASE WHEN r."halfDay" THEN 50 ELSE 100 END) FILTER (WHERE NOT t."paid"), 0)::int
                 AS "unpaidLeaveHundredths"
          FROM "AttendanceDay" d
          JOIN "Request" r ON r."employeeId" = d."employeeId" AND r."kind" = 'LEAVE'
                          AND r."state" = 'APPROVED' AND d."date" BETWEEN r."fromDate" AND r."toDate"
          JOIN "LeaveType" t ON t."id" = r."leaveTypeId"
         WHERE d."state" = 'LEAVE' AND d."employeeId" = ANY(${ids}::int[])
           AND d."date" BETWEEN ${period.startDate} AND ${period.endDate}
         GROUP BY d."employeeId"
      `,
      this.db.$queryRaw<{ employeeId: number; count: number }[]>`
        SELECT "employeeId", count(*)::int AS "count"
          FROM "Dependent"
         WHERE "employeeId" = ANY(${ids}::int[]) AND "state" = 'ACTIVE'
           AND "fromMonth" <= ${period.endDate}
           AND ("toMonth" IS NULL OR "toMonth" >= ${period.endDate})
         GROUP BY "employeeId"
      `,
      this.db.retroAdjustment.findMany({
        where: { employeeId: { in: ids }, state: "PENDING" },
      }),
      // PAID is outstanding whatever draft last pointed at it; the lock settles only what it issues.
      this.db.salaryAdvance.findMany({
        where: { employeeId: { in: ids }, state: "PAID" },
      }),
      this.db.employee.findMany({
        where: { id: { in: ids } },
        select: { id: true, legalEntityId: true, hireDate: true, leaveDate: true },
      }),
      this.db.holiday.findMany({
        where: { date: { gte: period.startDate, lte: period.endDate } },
        select: { date: true, legalEntityId: true, paid: true },
      }),
    ]);

    const payOf = new Map(pay.map((row) => [row.employeeId, row]));
    const leaving = new Set(
      people.filter((one) => one.leaveDate !== null && one.leaveDate <= period.endDate).map((one) => one.id),
    );
    const outsideOf = new Map(people.map((one) => [one.id, workdaysOutside(period, one, holidays)]));
    const allowanceOf = new Map<string, CalcAllowance[]>();
    for (const row of allowances) {
      const list = allowanceOf.get(row.recordId) ?? [];
      list.push({
        code: row.code,
        label: row.label,
        amount: BigInt(row.amount.split(".")[0]),
        taxable: row.taxable,
        insurable: row.insurable,
        taxFreeCap: row.taxFreeCap === null ? null : BigInt(row.taxFreeCap.split(".")[0]),
      });
      allowanceOf.set(row.recordId, list);
    }
    const dayOf = new Map(days.map((row) => [row.employeeId, row]));
    const leaveOf = new Map(leave.map((row) => [row.employeeId, row]));
    const dependentOf = new Map(dependents.map((row) => [row.employeeId, row.count]));
    const retroOf = new Map<number, CalcExtra[]>();
    const deductionOf = new Map<number, CalcDeduction[]>();
    const owe = (employeeId: number, deduction: CalcDeduction): void => {
      deductionOf.set(employeeId, [...(deductionOf.get(employeeId) ?? []), deduction]);
    };
    for (const row of retros) {
      // Its insurance already left the earlier period's taxable income, so it comes off after tax (KEHOACH 9.6).
      if (row.code === CARRY_CODE) {
        owe(row.employeeId, { code: `RETRO_${row.code}`, amount: toDong(row.amount) });
        continue;
      }
      const list = retroOf.get(row.employeeId) ?? [];
      list.push({ code: `RETRO_${row.code}`, label: row.label ?? undefined, amount: toDong(row.amount), taxable: true });
      retroOf.set(row.employeeId, list);
    }
    for (const row of advances) {
      owe(row.employeeId, { code: LINE_ADVANCE, amount: toDong(row.amount) });
    }

    const slips: Prisma.PayslipCreateManyInput[] = [];
    const linesOf = new Map<number, ReturnType<typeof calculate>["lines"]>();
    let gross = 0n;
    let net = 0n;

    for (const employeeId of ids) {
      const record = payOf.get(employeeId);
      if (!record) {
        continue;
      }
      const day = dayOf.get(employeeId);
      const off = leaveOf.get(employeeId);
      const paidLeave = off?.paidLeaveHundredths ?? 0;
      // A working day outside the employment dates is neither worked nor paid (KEHOACH 9.7).
      const unpaidWholeDays = (day?.absentDays ?? 0) + (outsideOf.get(employeeId) ?? 0);
      const unpaid = (off?.unpaidLeaveHundredths ?? 0) + unpaidWholeDays * 100;
      const paidDays = ((day?.workedDays ?? 0) + (day?.holidayDays ?? 0)) * 100 + paidLeave;
      const priced = policyOf.get(employeeId) as RunPolicy;
      const result = calculate({
        policy: priced.calc,
        baseSalary: BigInt(record.baseSalary.split(".")[0]),
        insuranceSalary: BigInt(record.insuranceSalary.split(".")[0]),
        allowances: allowanceOf.get(record.recordId) ?? [],
        dependentCount: dependentOf.get(employeeId) ?? 0,
        paidDayHundredths: BigInt(paidDays),
        unpaidDayHundredths: BigInt(unpaid),
        overtime: {
          weekdayMinutes: day?.weekdayOt ?? 0,
          weekendMinutes: day?.weekendOt ?? 0,
          holidayMinutes: day?.holidayOt ?? 0,
          nightMinutes: 0,
        },
        extras: retroOf.get(employeeId) ?? [],
        deductions: deductionOf.get(employeeId) ?? [],
        carryShortfall: !leaving.has(employeeId),
      });
      linesOf.set(employeeId, result.lines);
      gross += result.grossPay;
      net += result.netPay;
      slips.push({
        runId,
        periodId: period.id,
        employeeId,
        policyId: priced.id,
        workedDays: day?.workedDays ?? 0,
        paidLeaveDays: daysOf(paidLeave),
        unpaidDays: daysOf(unpaid),
        workedMinutes: day?.workedMinutes ?? 0,
        overtimeMinutes: (day?.weekdayOt ?? 0) + (day?.weekendOt ?? 0) + (day?.holidayOt ?? 0),
        grossPay: result.grossPay.toString(),
        taxableIncome: result.taxableIncome.toString(),
        insuranceEmployee: result.insuranceEmployee.toString(),
        insuranceEmployer: result.insuranceEmployer.toString(),
        personalIncomeTax: result.personalIncomeTax.toString(),
        deductionsTotal: result.deductionsTotal.toString(),
        netPay: result.netPay.toString(),
      });
    }

    if (slips.length === 0) {
      return { gross, net, done: 0, retroIds: [], advanceIds: [] };
    }

    // A chunk lands whole or not at all: a payslip without its lines is a figure nobody can explain.
    const written = await this.db.$transaction(
      async (tx) => {
        await tx.payslip.createMany({ data: slips });
        const made = await tx.payslip.findMany({
          where: { runId, employeeId: { in: ids } },
          select: { id: true, employeeId: true },
        });
        const lineRows: Prisma.PayslipLineCreateManyInput[] = [];
        for (const slip of made) {
          const own = linesOf.get(slip.employeeId) ?? [];
          for (const [index, line] of own.entries()) {
            lineRows.push({
              payslipId: slip.id,
              ordinal: index + 1,
              kind: line.kind,
              code: line.code,
              label: line.label ?? null,
              amount: line.amount.toString(),
              quantity: line.quantity ?? null,
              rateBp: line.rateBp ?? null,
            });
          }
        }
        await tx.payslipLine.createMany({ data: lineRows });
        return made;
      },
      { timeout: kChunkTxMs },
    );

    return {
      gross,
      net,
      done: written.length,
      retroIds: retros.map((row) => row.id),
      advanceIds: advances.map((row) => row.id),
    };
  }

  /** Point what a draft deducted or paid back at it, so the lock settles exactly that and no more. */
  private async markCarried(
    tx: Prisma.TransactionClient,
    runId: string,
    periodId: string,
    retroIds: string[],
    advanceIds: string[],
  ): Promise<void> {
    await tx.$executeRaw`
      UPDATE "RetroAdjustment" a
         SET "appliedPeriodId" = ${periodId}
        FROM "Payslip" p
       WHERE p."runId" = ${runId}
         AND p."employeeId" = a."employeeId"
         AND a."id" = ANY(${retroIds}::text[])
         AND a."state" = 'PENDING'
    `;
    await tx.$executeRaw`
      UPDATE "SalaryAdvance" a
         SET "payslipId" = p."id"
        FROM "Payslip" p
       WHERE p."runId" = ${runId}
         AND p."employeeId" = a."employeeId"
         AND a."id" = ANY(${advanceIds}::text[])
         AND a."state" = 'PAID'
    `;
  }

  private async requireBonusReady(runId: string, periodId: string): Promise<void> {
    const items = await this.db.bonusItem.findMany({
      where: { runId },
      select: { employeeId: true },
    });
    if (items.length === 0) {
      throw new BadRequestException("BONUS_RUN_HAS_NO_ITEMS");
    }
    const ids = [...new Set(items.map((item) => item.employeeId))];
    const bases = await this.db.payslip.findMany({
      where: { periodId, employeeId: { in: ids }, run: { kind: "REGULAR", state: "DONE" } },
      select: { employeeId: true },
      distinct: ["employeeId"],
    });
    if (bases.length !== ids.length) {
      throw new BadRequestException("BONUS_NEEDS_A_REGULAR_PAYSLIP");
    }
  }

  /** Load the amounts a bonus run will pay; loading again replaces them and sends a finished run back to draft. */
  async setBonus(viewer: Viewer, runId: string, items: BonusItemDto[]): Promise<{ items: number }> {
    this.mayWrite(viewer);
    // Nobody sets their own pay (KEHOACH 9.4).
    refuseOwn(viewer, ...items.map((item) => item.employeeId));
    const run = await this.runOf(viewer, runId);
    if (run.kind !== "BONUS") {
      throw new BadRequestException("RUN_IS_NOT_A_BONUS");
    }
    const named = [...new Set(items.map((item) => item.employeeId))];
    const reached = await this.db.employee.count({ where: { id: { in: named }, ...ScopeService.peopleWhere(viewer, null) } });
    if (reached !== named.length) {
      throw new NotFoundException("EMPLOYEE_NOT_FOUND");
    }
    await this.reload(runId, run.periodId, async (tx) => {
      await tx.bonusItem.deleteMany({ where: { runId } });
      await tx.bonusItem.createMany({
        data: items.map((item) => ({
          runId,
          employeeId: item.employeeId,
          code: item.code,
          label: item.label ?? null,
          amount: item.amount,
          taxable: item.taxable ?? true,
        })),
      });
    });
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.PAYROLL_BONUS,
      subject: AUDIT_SUBJECTS.PAYROLL,
      subjectId: runId,
      meta: { items: items.length, total: items.reduce((sum, item) => sum + item.amount, 0) },
    });
    return { items: items.length };
  }

  async bonus(viewer: Viewer, runId: string): Promise<BonusRow[]> {
    this.mayWrite(viewer);
    const run = await this.runOf(viewer, runId);
    if (run.kind !== "BONUS") {
      throw new BadRequestException("RUN_IS_NOT_A_BONUS");
    }
    return this.db.bonusItem.findMany({
      where: { runId },
      include: { employee: { select: { id: true, code: true, fullName: true } } },
      orderBy: [{ code: "asc" }, { employeeId: "asc" }],
    });
  }

  /**
   * A bonus owes the difference between the tax on the period with it and the
   * tax without it, so it reads the regular payslip as its base (KEHOACH 9.18).
   */
  private async runBonus(runId: string, period: PayrollPeriod): Promise<PayrollRun> {
    const items = await this.db.bonusItem.findMany({ where: { runId }, orderBy: { code: "asc" } });
    const ids = [...new Set(items.map((item) => item.employeeId))];
    const policyOf = await this.policiesFor(period, await this.pricedAmong(ids));
    const [baseOf, dependents] = await Promise.all([
      this.taxBases(period.id, ids, runId),
      this.db.$queryRaw<{ employeeId: number; count: number }[]>`
        SELECT "employeeId", count(*)::int AS "count"
          FROM "Dependent"
         WHERE "employeeId" = ANY(${ids}::int[]) AND "state" = 'ACTIVE'
           AND "fromMonth" <= ${period.endDate}
           AND ("toMonth" IS NULL OR "toMonth" >= ${period.endDate})
         GROUP BY "employeeId"
      `,
    ]);
    const missing = ids.filter((id) => !baseOf.has(id));
    if (missing.length > 0) {
      throw new BadRequestException("BONUS_NEEDS_A_REGULAR_PAYSLIP");
    }
    const dependentOf = new Map(dependents.map((row) => [row.employeeId, row.count]));

    await this.db.payslip.deleteMany({ where: { runId } });
    const slips: Prisma.PayslipCreateManyInput[] = [];
    const linesOf = new Map<number, Prisma.PayslipLineCreateManyInput[]>();
    let gross = 0n;
    let net = 0n;

    for (const employeeId of ids) {
      const base = baseOf.get(employeeId);
      if (!base) {
        continue;
      }
      const own = items.filter((item) => item.employeeId === employeeId);
      const total = own.reduce((sum, item) => sum + toDong(item.amount), 0n);
      const taxablePart = own
        .filter((item) => item.taxable)
        .reduce((sum, item) => sum + toDong(item.amount), 0n);
      const { id: policyId, calc } = policyOf.get(employeeId) as RunPolicy;
      const relief = calc.selfDeduction + calc.dependentDeduction * BigInt(dependentOf.get(employeeId) ?? 0);
      const without = atLeastZero(base.taxable - base.insurance - relief);
      const withBonus = atLeastZero(without + taxablePart);
      const tax = taxOn(withBonus, calc.brackets) - taxOn(without, calc.brackets);

      const rows: Prisma.PayslipLineCreateManyInput[] = own.map((item, index) => ({
        payslipId: "",
        ordinal: index + 1,
        kind: "EARNING" as const,
        code: `BONUS_${item.code}`,
        label: item.label,
        amount: toDong(item.amount).toString(),
      }));
      rows.push({
        payslipId: "",
        ordinal: rows.length + 1,
        kind: "DEDUCTION",
        code: LINE_TAX,
        amount: tax.toString(),
      });
      linesOf.set(employeeId, rows);

      gross += total;
      net += total - tax;
      slips.push({
        runId,
        periodId: period.id,
        employeeId,
        policyId,
        grossPay: total.toString(),
        taxableIncome: taxablePart.toString(),
        personalIncomeTax: tax.toString(),
        deductionsTotal: tax.toString(),
        netPay: (total - tax).toString(),
      });
    }

    const written = await this.writeSlips(runId, slips, linesOf);

    return this.db.payrollRun.update({
      where: { id: runId },
      data: {
        state: "DONE",
        finishedAt: new Date(),
        failure: null,
        employeeCount: ids.length,
        doneCount: written,
        failedCount: ids.length - written,
        grossTotal: gross.toString(),
        netTotal: net.toString(),
      },
    });
  }

  /** A run's payslips and their lines in one transaction; returns how many landed. */
  private writeSlips(
    runId: string,
    slips: Prisma.PayslipCreateManyInput[],
    linesOf: Map<number, Prisma.PayslipLineCreateManyInput[]>,
  ): Promise<number> {
    return this.db.$transaction(
      async (tx) => {
        await tx.payslip.createMany({ data: slips });
        const made = await tx.payslip.findMany({ where: { runId }, select: { id: true, employeeId: true } });
        const lineRows = made.flatMap((slip) =>
          (linesOf.get(slip.employeeId) ?? []).map((line) => ({ ...line, payslipId: slip.id })),
        );
        await tx.payslipLine.createMany({ data: lineRows });
        return made.length;
      },
      { timeout: kChunkTxMs },
    );
  }

  /**
   * What each person's period already holds as taxable income: the regular
   * payslip the lock would issue, plus every other finished bonus, so a second
   * bonus is taxed from where the first one stopped (KEHOACH 9.18 item 9).
   */
  private async taxBases(periodId: string, ids: number[], runId: string): Promise<Map<number, TaxBase>> {
    const rows = await this.db.$queryRaw<{ employeeId: number; taxable: string; insurance: string }[]>`
      WITH regular AS (
        SELECT DISTINCT ON (s."employeeId") s."employeeId", s."taxableIncome", s."insuranceEmployee"
          FROM "Payslip" s
          JOIN "PayrollRun" r ON r."id" = s."runId"
         WHERE s."periodId" = ${periodId} AND r."kind" = 'REGULAR' AND r."state" = 'DONE'
           AND s."employeeId" = ANY(${ids}::int[])
         ORDER BY s."employeeId", r."finishedAt" DESC NULLS LAST, r."createdAt" DESC, r."id" DESC
      ),
      bonus AS (
        SELECT s."employeeId", sum(s."taxableIncome") AS "taxable"
          FROM "Payslip" s
          JOIN "PayrollRun" r ON r."id" = s."runId"
         WHERE s."periodId" = ${periodId} AND r."kind" = 'BONUS' AND r."state" = 'DONE'
           AND r."id" <> ${runId} AND s."employeeId" = ANY(${ids}::int[])
         GROUP BY s."employeeId"
      )
      SELECT g."employeeId",
             (g."taxableIncome" + coalesce(b."taxable", 0))::text AS "taxable",
             g."insuranceEmployee"::text AS "insurance"
        FROM regular g
        LEFT JOIN bonus b ON b."employeeId" = g."employeeId"
    `;
    return new Map(
      rows.map((row) => [row.employeeId, { taxable: toDong(row.taxable), insurance: toDong(row.insurance) }]),
    );
  }

  /** The payslips a lock issues: the newest finished regular and settlement run per person, every finished
   *  bonus; a regular one for someone paid that month from another period stays a draft (KEHOACH 9.6).
   */
  private chosenSlips(periodId: string): Prisma.Sql {
    return Prisma.sql`
      (SELECT DISTINCT ON (s."employeeId", r."kind") s."id"
         FROM "Payslip" s
         JOIN "PayrollRun" r ON r."id" = s."runId"
        WHERE s."periodId" = ${periodId} AND r."state" = 'DONE'
          AND r."kind" IN ('REGULAR', 'FINAL_SETTLEMENT')
          AND NOT (r."kind" = 'REGULAR' AND ${paidElsewhere(periodId)})
        ORDER BY s."employeeId", r."kind", r."finishedAt" DESC NULLS LAST, r."createdAt" DESC, r."id" DESC)
      UNION ALL
      (SELECT s."id"
         FROM "Payslip" s
         JOIN "PayrollRun" r ON r."id" = s."runId"
        WHERE s."periodId" = ${periodId} AND r."state" = 'DONE' AND r."kind" = 'BONUS')`;
  }

  /**
   * One person's year for the tax office: every figure is read back from the
   * issued payslips, and only the annual band is applied here.
   */
  async taxYear(viewer: Viewer, employeeId: number, year: number): Promise<TaxYearStatement> {
    const visible = await this.scope.deskOrSelfEmployeeIds(viewer);
    if (!(await this.scope.reaches(viewer, visible, employeeId))) {
      throw new NotFoundException("EMPLOYEE_NOT_FOUND");
    }
    const who = await this.db.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, code: true, fullName: true, taxCode: true, legalEntityId: true },
    });
    if (!who) {
      throw new NotFoundException("EMPLOYEE_NOT_FOUND");
    }
    const payslips = await this.db.payslip.findMany({
      where: { employeeId, state: { in: ISSUED_STATES }, period: { year } },
      include: {
        period: { select: { month: true } },
        lines: { where: { code: { in: READ_BACK } }, select: { code: true, amount: true } },
      },
      orderBy: { period: { month: "asc" } },
    });

    const months: TaxYearMonth[] = payslips.map((slip) => ({
      periodId: slip.periodId,
      month: slip.period.month,
      grossPay: slip.grossPay.toFixed(0),
      taxableIncome: slip.taxableIncome.toFixed(0),
      insuranceEmployee: slip.insuranceEmployee.toFixed(0),
      reliefSelf: sumOf(slip.lines, LINE_RELIEF_SELF).toString(),
      reliefDependent: sumOf(slip.lines, LINE_RELIEF_DEPENDENT).toString(),
      exemptOvertime: sumOf(slip.lines, LINE_EXEMPT_OVERTIME).toString(),
      taxWithheld: sumOf(slip.lines, LINE_TAX).toString(),
      netPay: slip.netPay.toFixed(0),
    }));

    const total = (pick: (one: TaxYearMonth) => string): Dong =>
      months.reduce((sum, one) => sum + BigInt(pick(one)), 0n);
    const taxable = total((one) => one.taxableIncome);
    const insurance = total((one) => one.insuranceEmployee);
    const reliefSelf = total((one) => one.reliefSelf);
    const reliefDependent = total((one) => one.reliefDependent);
    const withheld = total((one) => one.taxWithheld);

    // The year table of the policy in force at the close of the year settles the whole year.
    const policy = await this.policy.effectiveAt(new Date(Date.UTC(year, 11, 31)), who.legalEntityId);
    const assessable = atLeastZero(taxable - insurance - reliefSelf - reliefDependent);
    const due = taxOn(assessable, yearBrackets(asCalcPolicy(policy).brackets));

    return {
      employeeId: who.id,
      code: who.code,
      fullName: who.fullName,
      taxCode: who.taxCode,
      year,
      policyId: policy.id,
      months,
      grossTotal: total((one) => one.grossPay).toString(),
      taxableTotal: taxable.toString(),
      insuranceTotal: insurance.toString(),
      reliefSelfTotal: reliefSelf.toString(),
      reliefDependentTotal: reliefDependent.toString(),
      exemptOvertimeTotal: total((one) => one.exemptOvertime).toString(),
      assessableTotal: assessable.toString(),
      taxDue: due.toString(),
      taxWithheld: withheld.toString(),
      difference: (due - withheld).toString(),
    };
  }

  async payslips(viewer: Viewer, query: ListPayslipsDto): Promise<Page<PayslipRow>> {
    const visible = await this.scope.deskOrSelfEmployeeIds(viewer);
    if (query.employeeId !== undefined && !(await this.scope.reaches(viewer, visible, query.employeeId))) {
      throw new NotFoundException("EMPLOYEE_NOT_FOUND");
    }
    const where = await this.payslipWhere(query, viewer, visible);
    const [rows, found] = await Promise.all([
      this.db.payslip.findMany({
        where,
        include: PAYSLIP_ROW,
        // A bonus run gives one person two slips a month, so id breaks the tie (KEHOACH 9.9 rule 3).
        orderBy: [
          { period: { year: "desc" } },
          { period: { month: "desc" } },
          { employeeId: "asc" },
          { id: "asc" },
        ],
        take: query.take,
        ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      }),
      this.db.payslip.count({ where, take: COUNT_CEILING + 1 }),
    ]);
    const last = rows[rows.length - 1];
    return {
      ...countedTo(found),
      rows: rows.map(asPayslipRow),
      next: rows.length === query.take && last ? last.id : null,
    };
  }

  /** Every payslip the list filter reaches, as a file Excel opens. */
  async payslipsCsv(viewer: Viewer, query: ListPayslipsDto): Promise<string> {
    const visible = await this.scope.deskOrSelfEmployeeIds(viewer);
    const rows = await this.db.payslip.findMany({
      where: await this.payslipWhere(query, viewer, visible),
      include: PAYSLIP_ROW,
      orderBy: [{ employee: { code: "asc" } }, { id: "asc" }],
    });
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.EXPORT_PAYSLIPS,
      subject: AUDIT_SUBJECTS.EXPORT,
      subjectId: "payslips",
      meta: { filters: { ...query }, rows: rows.length },
    });
    return toExcelCsv(
      ["code", "fullName", "department", "run", "state", "gross", "insuranceEmployee", "tax", "advance", "net"],
      rows.map(asPayslipRow).map((row) => [
        row.employee.code,
        row.employee.fullName,
        row.employee.department?.name ?? "",
        row.run.kind,
        row.state,
        row.grossPay.toFixed(0),
        row.insuranceEmployee.toFixed(0),
        row.personalIncomeTax.toFixed(0),
        row.advance,
        row.netPay.toFixed(0),
      ]),
    );
  }

  // Both clauses write the same key, so a spread would let the scope overwrite the asked-for employee.
  private async payslipWhere(
    query: ListPayslipsDto,
    viewer: Viewer,
    visible: number[] | null,
  ): Promise<Prisma.PayslipWhereInput> {
    const term = query.search?.trim();
    return {
      AND: [
        query.periodId ? { periodId: query.periodId } : {},
        query.runId ? { runId: query.runId } : {},
        query.employeeId === undefined ? {} : { employeeId: query.employeeId },
        // A draft is a number nobody has stood behind yet, so only the desk reads one.
        visible === null ? slipsReached(viewer) : { employeeId: { in: visible }, state: { not: "DRAFT" } },
        query.issued ? { state: { not: "DRAFT" } } : {},
        term ? { employeeId: await namedFilter(this.db, term) } : {},
      ],
    };
  }

  /** What a period costs over the payslips it issues, or the ones a lock would issue while it is open. */
  async periodTotals(viewer: Viewer, periodId: string): Promise<PeriodTotals> {
    const period = await this.periodOf(viewer, periodId);
    const counted =
      period.state === "OPEN"
        ? this.chosenSlips(periodId)
        : Prisma.sql`SELECT "id" FROM "Payslip" WHERE "periodId" = ${periodId} AND "state" <> 'DRAFT'`;
    const [row] = await this.db.$queryRaw<Omit<PeriodTotals, "employerCost">[]>`
      SELECT count(*)::int                                   AS "payslips",
             count(DISTINCT p."employeeId")::int             AS "people",
             coalesce(sum(p."grossPay"), 0)::text            AS "gross",
             coalesce(sum(p."insuranceEmployee"), 0)::text   AS "insuranceEmployee",
             coalesce(sum(p."insuranceEmployer"), 0)::text   AS "insuranceEmployer",
             coalesce(sum(p."personalIncomeTax"), 0)::text   AS "tax",
             coalesce(sum(p."netPay"), 0)::text              AS "net"
        FROM "Payslip" p
       WHERE p."id" IN (${counted})
    `;
    return { ...row, employerCost: (toDong(row.gross) + toDong(row.insuranceEmployer)).toString() };
  }

  /** One payslip with every component; anyone but its owner reading it leaves a payslip.read line (KEHOACH 9.11). */
  async payslip(viewer: Viewer, id: string): Promise<PayslipDetail> {
    const visible = await this.scope.deskOrSelfEmployeeIds(viewer);
    const where: Prisma.PayslipWhereInput =
      visible === null ? { id, ...slipsReached(viewer) } : { id, employeeId: { in: visible }, state: { not: "DRAFT" } };
    const found = await this.db.payslip.findFirst({ where, include: { lines: { orderBy: { ordinal: "asc" } } } });
    if (!found) {
      throw new NotFoundException("PAYSLIP_NOT_FOUND");
    }
    if (found.employeeId !== viewer.employeeId) {
      await this.audit.record({
        actorId: viewer.userId,
        action: AUDIT_ACTIONS.PAYSLIP_READ,
        subject: AUDIT_SUBJECTS.EMPLOYEE,
        subjectId: String(found.employeeId),
        meta: { payslipId: found.id },
      });
    }
    if (found.employeeId === viewer.employeeId && found.viewedAt === null && found.state !== "DRAFT") {
      const viewed = await this.db.payslip.update({ where: { id }, data: { state: "VIEWED", viewedAt: new Date() } });
      return { ...viewed, lines: found.lines };
    }
    return found;
  }

  /**
   * Why this month differs from last, component by component. It is the
   * question every payslip raises and none of them answer (KEHOACH 9.17).
   */
  async compare(viewer: Viewer, id: string): Promise<PayslipDelta[]> {
    const slip = await this.payslip(viewer, id);
    const [period, run] = await Promise.all([
      this.requirePeriod(slip.periodId),
      this.db.payrollRun.findUniqueOrThrow({ where: { id: slip.runId }, select: { kind: true } }),
    ]);
    // A regular month compares with the previous regular month, never with a bonus paid in between.
    const before = await this.db.payslip.findFirst({
      where: {
        employeeId: slip.employeeId,
        state: { not: "DRAFT" },
        run: { kind: run.kind },
        period: {
          OR: [
            { year: period.year, month: { lt: period.month } },
            { year: { lt: period.year } },
          ],
        },
      },
      include: { lines: true, period: true },
      orderBy: [{ period: { year: "desc" } }, { period: { month: "desc" } }, { issuedAt: "desc" }, { id: "desc" }],
    });
    const past = new Map((before?.lines ?? []).map((line) => [line.code, toDong(line.amount)]));
    const codes = new Set([...slip.lines.map((line) => line.code), ...past.keys()]);
    const deltas: PayslipDelta[] = [];
    for (const code of codes) {
      const now = toDong(slip.lines.find((line) => line.code === code)?.amount ?? 0);
      const then = past.get(code) ?? 0n;
      if (now !== then) {
        deltas.push({
          code,
          thisPeriod: now.toString(),
          lastPeriod: then.toString(),
          difference: (now - then).toString(),
        });
      }
    }
    return deltas;
  }

  async delivery(viewer: Viewer, periodId: string): Promise<Delivery> {
    await this.periodOf(viewer, periodId);
    const issued = { periodId, state: { not: "DRAFT" as const } };
    const [all, sent] = await Promise.all([
      this.db.payslip.count({ where: issued }),
      this.db.payslip.count({ where: { ...issued, sentAt: { not: null } } }),
    ]);
    return { issued: all, sent };
  }

  /**
   * Queue one job per payslip that has not gone out. A job already queued is
   * harmless: the worker reads sentAt, so a second copy does nothing.
   */
  async deliver(viewer: Viewer, periodId: string): Promise<{ queued: number }> {
    this.mayWrite(viewer);
    const period = await this.periodOf(viewer, periodId);
    if (period.state === "OPEN") {
      throw new BadRequestException("PERIOD_NOT_LOCKED");
    }
    const waiting = await this.db.payslip.findMany({
      where: { periodId, sentAt: null, state: { not: "DRAFT" } },
      select: { id: true },
    });
    const queue = this.queues[QUEUE.payroll];
    await queue.addBulk(
      waiting.map((slip) => ({
        name: JOB.deliver,
        data: { type: JOB.deliver, payslipId: slip.id } satisfies PayrollJob,
        opts: { jobId: `payslip-${slip.id}` },
      })),
    );
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.PAYROLL_DELIVER,
      subject: AUDIT_SUBJECTS.PAYROLL,
      subjectId: periodId,
      meta: { queued: waiting.length },
    });
    return { queued: waiting.length };
  }

  /** Record that a payslip's mail left: sentAt once, and only an ISSUED slip turns SENT, so an opened one stays VIEWED (KEHOACH 9.11). */
  async markSent(payslipId: string): Promise<void> {
    await this.db.$transaction([
      this.db.payslip.updateMany({ where: { id: payslipId, sentAt: null }, data: { sentAt: new Date() } }),
      this.db.payslip.updateMany({ where: { id: payslipId, state: "ISSUED" }, data: { state: "SENT" } }),
    ]);
  }

  /**
   * The file a bank or an accountant takes. Columns are chosen by kind rather
   * than hand-edited afterwards, which is where a payment file goes wrong.
   */
  async exportRows(viewer: Viewer, periodId: string, kind: ExportKind): Promise<string> {
    this.mayWrite(viewer);
    const period = await this.periodOf(viewer, periodId);
    if (period.state === "OPEN") {
      throw new BadRequestException("PERIOD_NOT_LOCKED");
    }
    const rows = await this.db.payslip.findMany({
      where: { periodId, state: { not: "DRAFT" } },
      include: {
        employee: {
          select: {
            code: true,
            fullName: true,
            department: { select: { code: true, name: true, costCentre: true } },
          },
        },
        lines: { where: { code: LINE_CARRY_OUT }, select: { code: true, amount: true } },
      },
      orderBy: { employee: { code: "asc" } },
    });
    await this.audit.record({
      actorId: viewer.userId,
      action: kind === "bank" ? AUDIT_ACTIONS.EXPORT_BANK : AUDIT_ACTIONS.EXPORT_LEDGER,
      subject: AUDIT_SUBJECTS.PAYROLL,
      subjectId: periodId,
      meta: { filters: { kind }, rows: rows.length },
    });
    const reference = `LUONG ${String(period.month).padStart(2, "0")}${period.year}`;
    if (kind === "bank") {
      // A bank takes no zero or negative transfer; a shortfall is carried or left to HR (KEHOACH 9.6).
      return toExcelCsv(
        ["code", "fullName", "bankName", "bankAccount", "amount", "reference"],
        rows.filter((row) => row.netPay.gt(0)).map((row) => [
          row.employee.code,
          row.employee.fullName,
          row.bankName ?? "",
          row.bankAccount ?? "",
          row.netPay.toFixed(0),
          reference,
        ]),
      );
    }
    return toExcelCsv(
      [
        "code",
        "fullName",
        "costCentre",
        "department",
        "gross",
        "insuranceEmployee",
        "insuranceEmployer",
        "tax",
        "net",
        "carried",
      ],
      rows.map((row) => [
        row.employee.code,
        row.employee.fullName,
        row.employee.department?.costCentre ?? "",
        row.employee.department?.name ?? "",
        row.grossPay.toFixed(0),
        row.insuranceEmployee.toFixed(0),
        row.insuranceEmployer.toFixed(0),
        row.personalIncomeTax.toFixed(0),
        row.netPay.toFixed(0),
        sumOf(row.lines, LINE_CARRY_OUT).toString(),
      ]),
    );
  }

  /**
   * The evidence a signer needs: tenure, half a month's pay, the leave nobody
   * took, and what they still hold. The two amounts the system cannot derive
   * are typed beside this (KEHOACH 9.18.8).
   */
  async settlementSheet(viewer: Viewer, runId: string): Promise<SettlementSheet> {
    this.mayWrite(viewer);
    const run = await this.runOf(viewer, runId);
    if (run.kind !== "FINAL_SETTLEMENT") {
      throw new BadRequestException("RUN_IS_NOT_A_SETTLEMENT");
    }
    const period = run.period;
    const leavers = await this.leaversOf(period);
    const ids = leavers.map((one) => one.id);
    const [balances, assets, held] = await Promise.all([
      this.db.leaveBalance.findMany({
        where: { employeeId: { in: ids }, year: period.year, leaveType: { paid: true } },
        include: { leaveType: { select: { code: true, name: true } } },
      }),
      this.db.asset.findMany({
        where: { holderId: { in: ids }, state: "ISSUED" },
        select: { id: true, code: true, name: true, holderId: true },
        orderBy: { code: "asc" },
      }),
      this.db.settlementItem.findMany({ where: { runId }, orderBy: { kind: "asc" } }),
    ]);
    const policyOf = await this.policiesFor(period, leavers);

    return {
      runId,
      periodId: period.id,
      rows: leavers.map((one) => {
        const standardDays = (policyOf.get(one.id) as RunPolicy).calc.standardDayHundredths;
        const daily = mulDiv(toDong(one.baseSalary), kHundred, standardDays);
        const unused = balances
          .filter((row) => row.employeeId === one.id)
          .reduce((sum, row) => sum + freeDays(row), 0);
        return {
          employeeId: one.id,
          code: one.code,
          fullName: one.fullName,
          leaveDate: asDay(one.leaveDate),
          tenureMonths: one.tenureMonths,
          baseSalary: toDong(one.baseSalary).toString(),
          halfMonthPay: mulDiv(toDong(one.baseSalary), 1n, 2n).toString(),
          unusedLeaveDays: unused,
          leavePayout: mulDiv(daily, BigInt(Math.round(unused * 100)), kHundred).toString(),
          assetsHeld: assets
            .filter((row) => row.holderId === one.id)
            .map((row) => ({ code: row.code, name: row.name })),
          typed: held
            .filter((row) => row.employeeId === one.id)
            .map((row) => ({
              kind: row.kind,
              label: row.label,
              amount: row.amount.toFixed(0),
              taxable: row.taxable,
              note: row.note,
            })),
        };
      }),
    };
  }

  /** Load the typed halves of a settlement; loading again replaces them and sends a finished run back to draft. */
  async setSettlement(
    viewer: Viewer,
    runId: string,
    items: SettlementItemDto[],
  ): Promise<{ items: number }> {
    this.mayWrite(viewer);
    refuseOwn(viewer, ...items.map((item) => item.employeeId));
    const run = await this.runOf(viewer, runId);
    if (run.kind !== "FINAL_SETTLEMENT") {
      throw new BadRequestException("RUN_IS_NOT_A_SETTLEMENT");
    }
    const leavers = await this.leaversOf(run.period);
    const allowed = new Set(leavers.map((one) => one.id));
    const stray = items.find((item) => !allowed.has(item.employeeId));
    if (stray) {
      throw new BadRequestException("EMPLOYEE_DID_NOT_LEAVE_THIS_PERIOD");
    }
    await this.reload(runId, run.periodId, async (tx) => {
      await tx.settlementItem.deleteMany({ where: { runId } });
      await tx.settlementItem.createMany({
        data: items.map((item) => ({
          runId,
          employeeId: item.employeeId,
          kind: item.kind,
          label: item.label ?? null,
          amount: item.amount,
          taxable: item.taxable ?? item.kind !== "SEVERANCE",
          note: item.note ?? null,
          createdById: viewer.userId,
        })),
      });
    });
    const totalOf = (kind: SettlementKind) =>
      items.filter((item) => item.kind === kind).reduce((sum, item) => sum + BigInt(item.amount), 0n).toString();
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.PAYROLL_SETTLEMENT,
      subject: AUDIT_SUBJECTS.PAYROLL,
      subjectId: runId,
      meta: { items: items.length, total: { SEVERANCE: totalOf("SEVERANCE"), ASSET_OFFSET: totalOf("ASSET_OFFSET") } },
    });
    return { items: items.length };
  }

  /** Everybody whose leave date falls inside this period, with the pay in
   *  force on that date and how long they had been there.
   */
  private leaversOf(period: PayrollPeriod): Promise<Leaver[]> {
    return this.db.$queryRaw<Leaver[]>`
      SELECT e."id", e."code", e."fullName", e."leaveDate", e."legalEntityId",
             COALESCE(c."baseSalary", 0) AS "baseSalary",
             COALESCE(
               EXTRACT(YEAR FROM age(e."leaveDate", e."hireDate")) * 12
                 + EXTRACT(MONTH FROM age(e."leaveDate", e."hireDate")),
               0
             )::int AS "tenureMonths"
        FROM "Employee" e
        LEFT JOIN LATERAL (
          SELECT r."baseSalary" FROM "CompensationRecord" r
           WHERE r."employeeId" = e."id" AND r."effectiveFrom" <= ${period.endDate}
           ORDER BY r."effectiveFrom" DESC LIMIT 1
        ) c ON true
       WHERE e."leaveDate" >= ${period.startDate} AND e."leaveDate" <= ${period.endDate}
         AND e."legalEntityId" = ${period.legalEntityId}
       ORDER BY e."id"
    `;
  }

  /** The people a run prices: its bonus lines' people, the period's leavers, or everyone the period covers. */
  private async pricedBy(run: PayrollRun & { period: PayrollPeriod }): Promise<Priced[]> {
    if (run.kind === "BONUS") {
      const items = await this.db.bonusItem.findMany({ where: { runId: run.id }, select: { employeeId: true } });
      return this.pricedAmong([...new Set(items.map((item) => item.employeeId))]);
    }
    if (run.kind === "FINAL_SETTLEMENT") {
      return this.leaversOf(run.period);
    }
    // Someone with no pay record is the checklist's NO_COMPENSATION, not a failed payslip (KEHOACH 9.6).
    return this.db.employee.findMany({
      where: {
        ...coveredBy(run.period),
        ...(run.departmentId ? { departmentId: run.departmentId } : {}),
        compensation: { some: { effectiveFrom: { lte: run.period.endDate } } },
      },
      select: { id: true, legalEntityId: true },
      orderBy: { id: "asc" },
    });
  }

  private pricedAmong(ids: number[]): Promise<Priced[]> {
    return this.db.employee.findMany({ where: { id: { in: ids } }, select: { id: true, legalEntityId: true } });
  }

  /** Each priced person's policy in force at the period's end, chosen by their own entity (KEHOACH 9.7). */
  private async policiesFor(period: PayrollPeriod, people: readonly Priced[]): Promise<Map<number, RunPolicy>> {
    const byEntity = await this.policy.inForce(period.endDate, people.map((one) => one.legalEntityId));
    const priced = new Map<string | null, RunPolicy>();
    for (const [entity, policy] of byEntity) {
      priced.set(entity, { id: policy.id, calc: asCalcPolicy(policy) });
    }
    return new Map(people.map((one) => [one.id, priced.get(one.legalEntityId) as RunPolicy]));
  }

  private async requireSettlementReady(period: PayrollPeriod): Promise<void> {
    const leavers = await this.leaversOf(period);
    if (leavers.length === 0) {
      throw new BadRequestException("PERIOD_HAS_NO_LEAVERS");
    }
    const bases = await this.db.payslip.findMany({
      where: {
        periodId: period.id,
        employeeId: { in: leavers.map((one) => one.id) },
        run: { kind: "REGULAR", state: "DONE" },
      },
      select: { employeeId: true },
      distinct: ["employeeId"],
    });
    if (bases.length !== leavers.length) {
      throw new BadRequestException("SETTLEMENT_NEEDS_A_REGULAR_PAYSLIP");
    }
  }

  /**
   * What leaving costs, beside the payslip for the days worked: the leave
   * nobody took, the figures somebody signed for, and tax on the part that is
   * not exempt, charged as the increment over the period (KEHOACH 9.18.8).
   */
  private async runSettlement(runId: string, period: PayrollPeriod): Promise<PayrollRun> {
    const leavers = await this.leaversOf(period);
    const policyOf = await this.policiesFor(period, leavers);
    const ids = leavers.map((one) => one.id);
    const [items, balances, baseOf, dependents] = await Promise.all([
      this.db.settlementItem.findMany({ where: { runId }, orderBy: { kind: "asc" } }),
      this.db.leaveBalance.findMany({
        where: { employeeId: { in: ids }, year: period.year, leaveType: { paid: true } },
      }),
      this.taxBases(period.id, ids, runId),
      this.db.$queryRaw<{ employeeId: number; count: number }[]>`
        SELECT "employeeId", count(*)::int AS "count"
          FROM "Dependent"
         WHERE "employeeId" = ANY(${ids}::int[]) AND "state" = 'ACTIVE'
           AND "fromMonth" <= ${period.endDate}
           AND ("toMonth" IS NULL OR "toMonth" >= ${period.endDate})
         GROUP BY "employeeId"
      `,
    ]);
    const dependentOf = new Map(dependents.map((row) => [row.employeeId, row.count]));

    await this.db.payslip.deleteMany({ where: { runId } });
    const slips: Prisma.PayslipCreateManyInput[] = [];
    const linesOf = new Map<number, Prisma.PayslipLineCreateManyInput[]>();
    let gross = 0n;
    let net = 0n;

    for (const one of leavers) {
      const base = baseOf.get(one.id);
      if (!base) {
        continue;
      }
      const { id: policyId, calc } = policyOf.get(one.id) as RunPolicy;
      const daily = mulDiv(toDong(one.baseSalary), kHundred, calc.standardDayHundredths);
      const unusedHundredths = balances
        .filter((row) => row.employeeId === one.id)
        .reduce((sum, row) => sum + BigInt(Math.round(freeDays(row) * 100)), 0n);
      const payout = unusedHundredths > 0n ? mulDiv(daily, unusedHundredths, kHundred) : 0n;
      const own = items.filter((item) => item.employeeId === one.id);

      const rows: Prisma.PayslipLineCreateManyInput[] = [];
      let earned = payout;
      let taxablePart = payout;
      let deducted = 0n;
      if (payout > 0n) {
        rows.push({
          payslipId: "",
          ordinal: rows.length + 1,
          kind: "EARNING",
          code: LINE_LEAVE_PAYOUT,
          amount: payout.toString(),
          quantity: (Number(unusedHundredths) / 100).toFixed(2),
        });
      }
      for (const item of own) {
        const amount = toDong(item.amount);
        const offset = item.kind === "ASSET_OFFSET";
        if (offset) {
          deducted += amount;
        } else {
          earned += amount;
          taxablePart += item.taxable ? amount : 0n;
        }
        rows.push({
          payslipId: "",
          ordinal: rows.length + 1,
          kind: offset ? "DEDUCTION" : "EARNING",
          code: offset ? LINE_ASSET_OFFSET : LINE_SEVERANCE,
          label: item.label,
          amount: amount.toString(),
        });
      }

      const relief =
        calc.selfDeduction + calc.dependentDeduction * BigInt(dependentOf.get(one.id) ?? 0);
      const without = atLeastZero(base.taxable - base.insurance - relief);
      const tax = taxOn(without + taxablePart, calc.brackets) - taxOn(without, calc.brackets);
      if (tax > 0n) {
        rows.push({
          payslipId: "",
          ordinal: rows.length + 1,
          kind: "DEDUCTION",
          code: LINE_TAX,
          amount: tax.toString(),
        });
      }
      if (rows.length === 0) {
        continue;
      }
      linesOf.set(one.id, rows);

      const takeHome = earned - deducted - tax;
      gross += earned;
      net += takeHome;
      slips.push({
        runId,
        periodId: period.id,
        employeeId: one.id,
        policyId,
        grossPay: earned.toString(),
        taxableIncome: taxablePart.toString(),
        personalIncomeTax: tax.toString(),
        deductionsTotal: (deducted + tax).toString(),
        netPay: takeHome.toString(),
      });
    }

    const written = await this.writeSlips(runId, slips, linesOf);

    await this.audit.record({
      action: AUDIT_ACTIONS.PAYROLL_RUN,
      subject: AUDIT_SUBJECTS.PAYROLL,
      subjectId: runId,
      meta: { leavers: ids.length, payslips: written },
    });
    return this.db.payrollRun.update({
      where: { id: runId },
      data: {
        state: "DONE",
        finishedAt: new Date(),
        failure: null,
        employeeCount: ids.length,
        doneCount: written,
        failedCount: ids.length - written,
        grossTotal: gross.toString(),
        netTotal: net.toString(),
      },
    });
  }

  /** A period the viewer answers for; one of another entity answers as absent (KEHOACH 9.4). */
  private async periodOf(viewer: Viewer, periodId: string): Promise<PayrollPeriod> {
    const period = await this.requirePeriod(periodId);
    if (!ScopeService.reachesEntity(viewer, period.legalEntityId)) {
      throw new NotFoundException("PERIOD_NOT_FOUND");
    }
    return period;
  }

  /** A run of a period the viewer answers for, with that period. */
  private async runOf(viewer: Viewer, runId: string): Promise<PayrollRun & { period: PayrollPeriod }> {
    const run = await this.db.payrollRun.findUnique({ where: { id: runId }, include: { period: true } });
    if (!run || !ScopeService.reachesEntity(viewer, run.period.legalEntityId)) {
      throw new NotFoundException("RUN_NOT_FOUND");
    }
    return run;
  }

  private async requirePeriod(periodId: string): Promise<PayrollPeriod> {
    const found = await this.db.payrollPeriod.findUnique({ where: { id: periodId } });
    if (!found) {
      throw new NotFoundException("PERIOD_NOT_FOUND");
    }
    return found;
  }
}
