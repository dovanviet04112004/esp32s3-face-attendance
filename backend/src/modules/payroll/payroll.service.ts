import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type {
  Payslip,
  PayslipLine,
  PayslipState,
  PayrollPeriod,
  PayrollRun,
  PeriodState,
  Prisma,
} from "@prisma/client";

import { toCsv } from "../../common/csv.js";
import { ScopeService } from "../../common/scope/scope.service.js";
import type { Viewer } from "../../common/scope/viewer.js";
import { PrismaService } from "../../database/prisma.service.js";
import { QUEUE_TOKEN, type Queues } from "../../queue/queue.module.js";
import { QUEUE, type PayrollJob } from "../../queue/queues.js";
import { AUDIT_ACTIONS, AUDIT_SUBJECTS } from "../audit/audit-actions.js";
import { AuditService } from "../audit/audit.service.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { asCalcPolicy, PolicyService } from "../policy/policy.service.js";
import {
  calculate,
  taxOn,
  LINE_EXEMPT_OVERTIME,
  LINE_RELIEF_DEPENDENT,
  LINE_RELIEF_SELF,
  LINE_TAX,
  type CalcAllowance,
  type CalcDeduction,
  type CalcExtra,
} from "./calculate.js";
import type {
  BonusItemDto,
  CreatePeriodDto,
  CreateRunDto,
  LockPeriodDto,
} from "./dto/payroll.dto.js";
import { atLeastZero, toDong, type Dong } from "./money.js";

const WRITERS: ReadonlySet<string> = new Set(["ADMIN", "PAYROLL"]);
const kChunk = 500;

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
  paidLeave: number;
  unpaidLeave: number;
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

export type PayslipRow = Payslip & { period: { year: number; month: number; state: PeriodState } };

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
const READ_BACK = [LINE_RELIEF_SELF, LINE_RELIEF_DEPENDENT, LINE_EXEMPT_OVERTIME, LINE_TAX];

function sumOf(lines: { code: string; amount: Prisma.Decimal }[], code: string): Dong {
  return lines
    .filter((line) => line.code === code)
    .reduce((total, line) => total + toDong(line.amount), 0n);
}

@Injectable()
export class PayrollService {
  constructor(
    private readonly db: PrismaService,
    private readonly scope: ScopeService,
    private readonly policy: PolicyService,
    private readonly audit: AuditService,
    private readonly notices: NotificationsService,
    @Inject(QUEUE_TOKEN) private readonly queues: Queues,
  ) {}

  private mayWrite(viewer: Viewer): void {
    if (!WRITERS.has(viewer.role)) {
      throw new ForbiddenException("PAYROLL_WRITE_DENIED");
    }
  }

  periods(legalEntityId?: string): Promise<PayrollPeriod[]> {
    return this.db.payrollPeriod.findMany({
      where: legalEntityId ? { legalEntityId } : {},
      orderBy: [{ year: "desc" }, { month: "desc" }],
    });
  }

  async createPeriod(viewer: Viewer, body: CreatePeriodDto): Promise<PayrollPeriod> {
    this.mayWrite(viewer);
    const start = new Date(Date.UTC(body.year, body.month - 1, 1));
    const end = new Date(Date.UTC(body.year, body.month, 0));
    return this.db.payrollPeriod.create({
      data: {
        legalEntityId: body.legalEntityId ?? null,
        year: body.year,
        month: body.month,
        startDate: start,
        endDate: end,
        payDate: body.payDate ? new Date(body.payDate) : null,
      },
    });
  }

  /**
   * What is still unsettled in a period. Locking over an open item is allowed
   * but names who accepted it, so the decision has an owner (KEHOACH 9.18).
   */
  async checklist(periodId: string): Promise<ChecklistItem[]> {
    const period = await this.requirePeriod(periodId);
    const [
      pendingRequests,
      missingPay,
      unbuiltDays,
      openCorrections,
      strays,
      stillHolding,
      lateDisputes,
    ] = await Promise.all([
      this.db.request.count({
        where: { state: "PENDING", fromDate: { lte: period.endDate }, toDate: { gte: period.startDate } },
      }),
      this.db.employee.count({
        where: {
          active: true,
          ...(period.legalEntityId ? { legalEntityId: period.legalEntityId } : {}),
          compensation: { none: { effectiveFrom: { lte: period.endDate } } },
        },
      }),
      this.db.employee.count({
        where: {
          active: true,
          ...(period.legalEntityId ? { legalEntityId: period.legalEntityId } : {}),
          days: { none: { date: { gte: period.startDate, lte: period.endDate } } },
        },
      }),
      this.db.request.count({
        where: {
          kind: "ATTENDANCE_FIX",
          state: "PENDING",
          fromDate: { lte: period.endDate },
          toDate: { gte: period.startDate },
        },
      }),
      // A person with no legal entity is invisible to every entity-scoped run,
      // so they would go unpaid with nothing reporting it.
      period.legalEntityId
        ? this.db.employee.count({ where: { active: true, legalEntityId: null } })
        : Promise.resolve(0),
      // Somebody who left this month and still holds a laptop: the last payslip
      // is the last moment anything can be set against (KEHOACH 9.16 item 10).
      this.db.employee.count({
        where: {
          leaveDate: { gte: period.startDate, lte: period.endDate },
          ...(period.legalEntityId ? { legalEntityId: period.legalEntityId } : {}),
          assetsHeld: { some: { state: "ISSUED" } },
        },
      }),
      // A deadline nobody feels is a decoration, so an unanswered one costs
      // somebody a signature here (KEHOACH 9.17 item 11).
      this.db.payslipDispute.count({
        where: {
          state: "OPEN",
          dueAt: { lt: new Date() },
          ...(period.legalEntityId
            ? { payslip: { period: { legalEntityId: period.legalEntityId } } }
            : {}),
        },
      }),
    ]);
    return [
      { code: "REQUESTS_PENDING", count: pendingRequests },
      { code: "CORRECTIONS_OPEN", count: openCorrections },
      { code: "NO_COMPENSATION", count: missingPay },
      { code: "NO_ATTENDANCE_DAYS", count: unbuiltDays },
      { code: "NO_LEGAL_ENTITY", count: strays },
      { code: "LEAVERS_HOLDING_ASSETS", count: stillHolding },
      { code: "DISPUTES_OVERDUE", count: lateDisputes },
    ];
  }

  async lock(viewer: Viewer, periodId: string, body: LockPeriodDto): Promise<PayrollPeriod> {
    this.mayWrite(viewer);
    const period = await this.requirePeriod(periodId);
    if (period.state !== "OPEN") {
      throw new BadRequestException("PERIOD_NOT_OPEN");
    }
    const open = (await this.checklist(periodId)).filter((item) => item.count > 0);
    if (open.length > 0 && !body.acceptOpenItems) {
      throw new BadRequestException("CHECKLIST_NOT_CLEAR");
    }
    // Issuing and spending are one act: a half-applied lock leaves a period
    // closed with its back payments still owed.
    const locked = await this.db.$transaction(async (tx) => {
      const shut = await tx.payrollPeriod.update({
        where: { id: periodId },
        data: {
          state: "LOCKED",
          lockedAt: new Date(),
          lockedById: viewer.userId,
          lockNote: body.note ?? null,
        },
      });
      await tx.payslip.updateMany({
        where: { periodId, state: "DRAFT" },
        data: { state: "ISSUED", issuedAt: new Date() },
      });
      // Where the money lands is an input too, and locking freezes inputs
      // (KEHOACH 9.6).
      await tx.$executeRaw`
        UPDATE "Payslip" p
           SET "bankName" = e."bankName", "bankAccount" = e."bankAccount"
          FROM "Employee" e
         WHERE p."periodId" = ${periodId}
           AND p."employeeId" = e."id"
      `;
      await tx.$executeRaw`
        UPDATE "RetroAdjustment" a
           SET "state" = 'APPLIED', "appliedPeriodId" = ${periodId}
          FROM "Payslip" p
         WHERE p."periodId" = ${periodId}
           AND p."employeeId" = a."employeeId"
           AND a."state" = 'PENDING'
      `;
      await tx.$executeRaw`
        UPDATE "SalaryAdvance" a
           SET "state" = 'SETTLED', "settledAt" = now(), "payslipId" = p."id"
          FROM "Payslip" p
         WHERE p."periodId" = ${periodId}
           AND p."employeeId" = a."employeeId"
           AND a."state" = 'PAID'
           AND a."payslipId" IS NULL
      `;
      return shut;
    });
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.PAYROLL_LOCK,
      subject: AUDIT_SUBJECTS.PAYROLL,
      subjectId: periodId,
      meta: { openItems: open.map((item) => item.code) },
    });
    const told = await this.db.payslip.findMany({
      where: { periodId, state: "ISSUED" },
      select: { employeeId: true },
      distinct: ["employeeId"],
    });
    await this.notices.raiseMany(
      told.map((row) => row.employeeId),
      "PAYSLIP_ISSUED",
      { periodId },
    );
    return locked;
  }

  async markPaid(viewer: Viewer, periodId: string): Promise<PayrollPeriod> {
    this.mayWrite(viewer);
    const period = await this.requirePeriod(periodId);
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

  runs(periodId: string): Promise<PayrollRun[]> {
    return this.db.payrollRun.findMany({ where: { periodId }, orderBy: { createdAt: "desc" } });
  }

  async createRun(viewer: Viewer, body: CreateRunDto): Promise<PayrollRun> {
    this.mayWrite(viewer);
    await this.requirePeriod(body.periodId);
    return this.db.payrollRun.create({
      data: {
        periodId: body.periodId,
        kind: body.kind,
        label: body.label ?? null,
        departmentId: body.departmentId ?? null,
        createdById: viewer.userId,
        note: body.note ?? null,
      },
    });
  }

  /**
   * Calculate every payslip in a run. Overtime pays the lesser of the measured
   * minutes and the approved ones for that day (KEHOACH 9.17), and the inputs
   * are six grouped queries rather than one per person (KEHOACH 9.9).
   */
  async execute(viewer: Viewer, runId: string): Promise<PayrollRun> {
    this.mayWrite(viewer);
    const run = await this.requireRunnable(runId);
    if (run.kind === "BONUS") {
      // Answer here rather than queueing a job that cannot succeed.
      await this.requireBonusReady(run.id, run.periodId);
    }
    // BullMQ keeps completed jobs, so a job id derived from the run would let
    // only the first start do anything; RUNNING is what stops a double start.
    await this.queues[QUEUE.payroll].add("run", { type: "run", runId } satisfies PayrollJob);
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.PAYROLL_QUEUE,
      subject: AUDIT_SUBJECTS.PAYROLL,
      subjectId: runId,
    });
    return this.db.payrollRun.update({
      where: { id: run.id },
      data: { state: "RUNNING", startedAt: new Date(), doneCount: 0, failedCount: 0 },
    });
  }

  private async requireRunnable(runId: string): Promise<PayrollRun & { period: PayrollPeriod }> {
    const run = await this.db.payrollRun.findUnique({
      where: { id: runId },
      include: { period: true },
    });
    if (!run) {
      throw new NotFoundException("RUN_NOT_FOUND");
    }
    if (run.period.state !== "OPEN") {
      throw new BadRequestException("PERIOD_NOT_OPEN");
    }
    if (run.state === "RUNNING") {
      throw new BadRequestException("RUN_ALREADY_RUNNING");
    }
    if (run.kind === "FINAL_SETTLEMENT") {
      throw new BadRequestException("RUN_KIND_NOT_READY");
    }
    return run;
  }

  /** The work itself, called by the worker. A second delivery of the same job
   *  recomputes the same run rather than doubling it.
   */
  async runNow(runId: string): Promise<PayrollRun> {
    const run = await this.db.payrollRun.findUnique({
      where: { id: runId },
      include: { period: true },
    });
    if (!run) {
      throw new NotFoundException("RUN_NOT_FOUND");
    }

    const period = run.period;
    const policy = await this.policy.effectiveAt(period.endDate, period.legalEntityId);
    const calcPolicy = asCalcPolicy(policy);
    if (run.kind === "BONUS") {
      return this.runBonus(run.id, period, policy.id, calcPolicy);
    }

    const people = await this.db.employee.findMany({
      where: {
        active: true,
        ...(period.legalEntityId ? { legalEntityId: period.legalEntityId } : {}),
        ...(run.departmentId ? { departmentId: run.departmentId } : {}),
      },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    const ids = people.map((person) => person.id);

    await this.db.payrollRun.update({
      where: { id: runId },
      data: { state: "RUNNING", startedAt: new Date(), employeeCount: ids.length, doneCount: 0, failedCount: 0 },
    });
    // A rerun of a draft recomputes rather than appends: one payslip per person
    // per run, whatever any earlier attempt left behind.
    await this.db.payslip.deleteMany({ where: { runId } });

    let grossTotal = 0n;
    let netTotal = 0n;
    let done = 0;

    for (let at = 0; at < ids.length; at += kChunk) {
      const slice = ids.slice(at, at + kChunk);
      const result = await this.runChunk(runId, period, policy.id, calcPolicy, slice);
      grossTotal += result.gross;
      netTotal += result.net;
      done += result.done;
      await this.db.payrollRun.update({ where: { id: runId }, data: { doneCount: done } });
    }

    await this.audit.record({
      actorId: run.createdById ?? undefined,
      action: AUDIT_ACTIONS.PAYROLL_RUN,
      subject: AUDIT_SUBJECTS.PAYROLL,
      subjectId: runId,
      meta: { employees: ids.length, payslips: done },
    });
    return this.db.payrollRun.update({
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
  }

  private async runChunk(
    runId: string,
    period: PayrollPeriod,
    policyId: string,
    calcPolicy: ReturnType<typeof asCalcPolicy>,
    ids: number[],
  ): Promise<{ gross: Dong; net: Dong; done: number }> {
    const [pay, allowances, days, leave, dependents, retros, advances] = await Promise.all([
      this.db.$queryRaw<PayRow[]>`
        SELECT DISTINCT ON (c."employeeId")
               c."employeeId", c."id" AS "recordId",
               c."baseSalary"::text, c."insuranceSalary"::text
          FROM "CompensationRecord" c
         WHERE c."employeeId" = ANY(${ids}::int[]) AND c."effectiveFrom" <= ${period.endDate}
         ORDER BY c."employeeId", c."effectiveFrom" DESC
      `,
      this.db.$queryRaw<
        { recordId: string; code: string; label: string; amount: string; taxable: boolean; insurable: boolean }[]
      >`
        SELECT a."recordId", a."code", a."label", a."amount"::text, a."taxable", a."insurable"
          FROM "CompensationAllowance" a
          JOIN "CompensationRecord" c ON c."id" = a."recordId"
         WHERE c."employeeId" = ANY(${ids}::int[]) AND c."effectiveFrom" <= ${period.endDate}
      `,
      this.db.$queryRaw<DayTally[]>`
        WITH paid AS (
          SELECT d."employeeId", d."state", d."workedMinutes",
                 LEAST(d."overtimeMinutes", floor(coalesce(a."allowed", 0))::int) AS "overtimePaid"
            FROM "AttendanceDay" d
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
        SELECT "employeeId",
               count(*) FILTER (WHERE "state" = 'WORKED')::int  AS "workedDays",
               count(*) FILTER (WHERE "state" = 'HOLIDAY')::int AS "holidayDays",
               count(*) FILTER (WHERE "state" = 'ABSENT')::int  AS "absentDays",
               coalesce(sum("workedMinutes"), 0)::int           AS "workedMinutes",
               coalesce(sum("overtimePaid") FILTER (WHERE "state" = 'WORKED'), 0)::int  AS "weekdayOt",
               coalesce(sum("overtimePaid") FILTER (WHERE "state" = 'WEEKEND'), 0)::int AS "weekendOt",
               coalesce(sum("overtimePaid") FILTER (WHERE "state" = 'HOLIDAY'), 0)::int AS "holidayOt"
          FROM paid
         GROUP BY "employeeId"
      `,
      this.db.$queryRaw<LeaveTally[]>`
        SELECT d."employeeId",
               count(*) FILTER (WHERE t."paid")::int     AS "paidLeave",
               count(*) FILTER (WHERE NOT t."paid")::int AS "unpaidLeave"
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
      this.db.salaryAdvance.findMany({
        where: { employeeId: { in: ids }, state: "PAID", payslipId: null },
      }),
    ]);

    const payOf = new Map(pay.map((row) => [row.employeeId, row]));
    const allowanceOf = new Map<string, CalcAllowance[]>();
    for (const row of allowances) {
      const list = allowanceOf.get(row.recordId) ?? [];
      list.push({
        code: row.code,
        label: row.label,
        amount: BigInt(row.amount.split(".")[0]),
        taxable: row.taxable,
        insurable: row.insurable,
      });
      allowanceOf.set(row.recordId, list);
    }
    const dayOf = new Map(days.map((row) => [row.employeeId, row]));
    const leaveOf = new Map(leave.map((row) => [row.employeeId, row]));
    const dependentOf = new Map(dependents.map((row) => [row.employeeId, row.count]));
    const retroOf = new Map<number, CalcExtra[]>();
    for (const row of retros) {
      const list = retroOf.get(row.employeeId) ?? [];
      list.push({ code: `RETRO_${row.code}`, label: row.label ?? undefined, amount: toDong(row.amount), taxable: true });
      retroOf.set(row.employeeId, list);
    }
    const advanceOf = new Map<number, CalcDeduction[]>();
    for (const row of advances) {
      const list = advanceOf.get(row.employeeId) ?? [];
      list.push({ code: "ADVANCE", amount: toDong(row.amount) });
      advanceOf.set(row.employeeId, list);
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
      const paidLeave = off?.paidLeave ?? 0;
      const unpaid = (off?.unpaidLeave ?? 0) + (day?.absentDays ?? 0);
      const paidDays = (day?.workedDays ?? 0) + (day?.holidayDays ?? 0) + paidLeave;
      const result = calculate({
        policy: calcPolicy,
        baseSalary: BigInt(record.baseSalary.split(".")[0]),
        insuranceSalary: BigInt(record.insuranceSalary.split(".")[0]),
        allowances: allowanceOf.get(record.recordId) ?? [],
        dependentCount: dependentOf.get(employeeId) ?? 0,
        paidDayHundredths: BigInt(paidDays) * 100n,
        unpaidDayHundredths: BigInt(unpaid) * 100n,
        overtime: {
          weekdayMinutes: day?.weekdayOt ?? 0,
          weekendMinutes: day?.weekendOt ?? 0,
          holidayMinutes: day?.holidayOt ?? 0,
          nightMinutes: 0,
        },
        extras: retroOf.get(employeeId) ?? [],
        deductions: advanceOf.get(employeeId) ?? [],
      });
      linesOf.set(employeeId, result.lines);
      gross += result.grossPay;
      net += result.netPay;
      slips.push({
        runId,
        periodId: period.id,
        employeeId,
        policyId,
        workedDays: day?.workedDays ?? 0,
        paidLeaveDays: paidLeave,
        unpaidDays: unpaid,
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
      return { gross, net, done: 0 };
    }

    await this.db.payslip.createMany({ data: slips });
    const written = await this.db.payslip.findMany({
      where: { runId, employeeId: { in: ids } },
      select: { id: true, employeeId: true },
    });
    const lineRows: Prisma.PayslipLineCreateManyInput[] = [];
    for (const slip of written) {
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
    await this.db.payslipLine.createMany({ data: lineRows });

    return { gross, net, done: written.length };
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
      where: { periodId, employeeId: { in: ids }, run: { kind: "REGULAR" } },
      select: { employeeId: true },
      distinct: ["employeeId"],
    });
    if (bases.length !== ids.length) {
      throw new BadRequestException("BONUS_NEEDS_A_REGULAR_PAYSLIP");
    }
  }

  /** Load the amounts a bonus run will pay. Rerunning replaces them. */
  async setBonus(viewer: Viewer, runId: string, items: BonusItemDto[]): Promise<{ items: number }> {
    this.mayWrite(viewer);
    const run = await this.db.payrollRun.findUnique({ where: { id: runId } });
    if (!run) {
      throw new NotFoundException("RUN_NOT_FOUND");
    }
    if (run.kind !== "BONUS") {
      throw new BadRequestException("RUN_IS_NOT_A_BONUS");
    }
    await this.db.bonusItem.deleteMany({ where: { runId } });
    await this.db.bonusItem.createMany({
      data: items.map((item) => ({
        runId,
        employeeId: item.employeeId,
        code: item.code,
        label: item.label ?? null,
        amount: item.amount,
        taxable: item.taxable ?? true,
      })),
    });
    return { items: items.length };
  }

  /**
   * A bonus owes the difference between the tax on the period with it and the
   * tax without it, so it reads the regular payslip as its base (KEHOACH 9.18).
   */
  private async runBonus(
    runId: string,
    period: PayrollPeriod,
    policyId: string,
    calcPolicy: ReturnType<typeof asCalcPolicy>,
  ): Promise<PayrollRun> {
    const items = await this.db.bonusItem.findMany({ where: { runId }, orderBy: { code: "asc" } });
    const ids = [...new Set(items.map((item) => item.employeeId))];
    const [bases, dependents] = await Promise.all([
      this.db.payslip.findMany({
        where: { periodId: period.id, employeeId: { in: ids }, run: { kind: "REGULAR" } },
        select: {
          employeeId: true,
          taxableIncome: true,
          insuranceEmployee: true,
          createdAt: true,
        },
        orderBy: { createdAt: "desc" },
      }),
      this.db.$queryRaw<{ employeeId: number; count: number }[]>`
        SELECT "employeeId", count(*)::int AS "count"
          FROM "Dependent"
         WHERE "employeeId" = ANY(${ids}::int[]) AND "state" = 'ACTIVE'
           AND "fromMonth" <= ${period.endDate}
           AND ("toMonth" IS NULL OR "toMonth" >= ${period.endDate})
         GROUP BY "employeeId"
      `,
    ]);
    const baseOf = new Map<number, (typeof bases)[number]>();
    for (const row of bases) {
      if (!baseOf.has(row.employeeId)) {
        baseOf.set(row.employeeId, row);
      }
    }
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
      const relief =
        calcPolicy.selfDeduction +
        calcPolicy.dependentDeduction * BigInt(dependentOf.get(employeeId) ?? 0);
      const without = atLeastZero(
        toDong(base.taxableIncome) - toDong(base.insuranceEmployee) - relief,
      );
      const withBonus = atLeastZero(without + taxablePart);
      const tax = taxOn(withBonus, calcPolicy.brackets) - taxOn(without, calcPolicy.brackets);

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

    await this.db.payslip.createMany({ data: slips });
    const written = await this.db.payslip.findMany({
      where: { runId },
      select: { id: true, employeeId: true },
    });
    const lineRows = written.flatMap((slip) =>
      (linesOf.get(slip.employeeId) ?? []).map((line) => ({ ...line, payslipId: slip.id })),
    );
    await this.db.payslipLine.createMany({ data: lineRows });

    return this.db.payrollRun.update({
      where: { id: runId },
      data: {
        state: "DONE",
        finishedAt: new Date(),
        employeeCount: ids.length,
        doneCount: written.length,
        failedCount: ids.length - written.length,
        grossTotal: gross.toString(),
        netTotal: net.toString(),
      },
    });
  }

  /**
   * One person's year for the tax office: every figure is read back from the
   * issued payslips, and only the annual band is applied here.
   */
  async taxYear(viewer: Viewer, employeeId: number, year: number): Promise<TaxYearStatement> {
    const visible = await this.scope.visibleEmployeeIds(viewer);
    if (visible !== null && !visible.includes(employeeId)) {
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

    // The band table in force at the close of the year settles the whole year.
    const policy = await this.policy.effectiveAt(new Date(Date.UTC(year, 11, 31)), who.legalEntityId);
    const assessable = atLeastZero(taxable - insurance - reliefSelf - reliefDependent);
    const due = taxOn(assessable, asCalcPolicy(policy).brackets);

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

  async payslips(viewer: Viewer, periodId?: string, runId?: string): Promise<PayslipRow[]> {
    const visible = await this.scope.visibleEmployeeIds(viewer);
    return this.db.payslip.findMany({
      where: {
        ...(periodId ? { periodId } : {}),
        ...(runId ? { runId } : {}),
        ...(visible === null ? {} : { employeeId: { in: visible } }),
      },
      include: { period: { select: { year: true, month: true, state: true } } },
      orderBy: [{ periodId: "desc" }, { employeeId: "asc" }],
      take: 500,
    });
  }

  /** What one person may read about themselves, with every component. */
  async payslip(viewer: Viewer, id: string): Promise<PayslipDetail> {
    const found = await this.db.payslip.findUnique({ where: { id }, include: { lines: { orderBy: { ordinal: "asc" } } } });
    const visible = await this.scope.visibleEmployeeIds(viewer);
    if (!found || (visible !== null && !visible.includes(found.employeeId))) {
      throw new NotFoundException("PAYSLIP_NOT_FOUND");
    }
    if (found.employeeId === viewer.employeeId && found.viewedAt === null && found.state !== "DRAFT") {
      await this.db.payslip.update({ where: { id }, data: { state: "VIEWED", viewedAt: new Date() } });
    }
    return found;
  }

  /**
   * Why this month differs from last, component by component. It is the
   * question every payslip raises and none of them answer (KEHOACH 9.17).
   */
  async compare(viewer: Viewer, id: string): Promise<PayslipDelta[]> {
    const slip = await this.payslip(viewer, id);
    const period = await this.requirePeriod(slip.periodId);
    const before = await this.db.payslip.findFirst({
      where: {
        employeeId: slip.employeeId,
        state: { not: "DRAFT" },
        period: {
          OR: [
            { year: period.year, month: { lt: period.month } },
            { year: { lt: period.year } },
          ],
        },
      },
      include: { lines: true, period: true },
      orderBy: [{ period: { year: "desc" } }, { period: { month: "desc" } }],
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

  /**
   * Queue one job per payslip that has not gone out. A job already queued is
   * harmless: the worker reads sentAt, so a second copy does nothing.
   */
  async deliver(viewer: Viewer, periodId: string): Promise<{ queued: number }> {
    this.mayWrite(viewer);
    const period = await this.requirePeriod(periodId);
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
        name: "deliver",
        data: { type: "deliver", payslipId: slip.id } satisfies PayrollJob,
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

  /**
   * The file a bank or an accountant takes. Columns are chosen by kind rather
   * than hand-edited afterwards, which is where a payment file goes wrong.
   */
  async exportRows(viewer: Viewer, periodId: string, kind: ExportKind): Promise<string> {
    this.mayWrite(viewer);
    const period = await this.requirePeriod(periodId);
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
      },
      orderBy: { employee: { code: "asc" } },
    });
    const reference = `LUONG ${String(period.month).padStart(2, "0")}${period.year}`;
    if (kind === "bank") {
      return toCsv(
        ["code", "fullName", "bankName", "bankAccount", "amount", "reference"],
        rows.map((row) => [
          row.employee.code,
          row.employee.fullName,
          row.bankName ?? "",
          row.bankAccount ?? "",
          row.netPay.toFixed(0),
          reference,
        ]),
      );
    }
    return toCsv(
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
      ]),
    );
  }

  private async requirePeriod(periodId: string): Promise<PayrollPeriod> {
    const found = await this.db.payrollPeriod.findUnique({ where: { id: periodId } });
    if (!found) {
      throw new NotFoundException("PERIOD_NOT_FOUND");
    }
    return found;
  }
}
