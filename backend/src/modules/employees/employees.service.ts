import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { Employee, Prisma } from "@prisma/client";

import { COUNT_CEILING, countedTo, decodeCursor, nextCursor } from "../../common/dto/cursor.dto.js";
import type { Page } from "../../common/dto/pagination.dto.js";
import { ScopeService } from "../../common/scope/scope.service.js";
import type { Viewer } from "../../common/scope/viewer.js";
import { toExcelCsv } from "../../common/csv.js";
import { PrismaService } from "../../database/prisma.service.js";
import { AUDIT_ACTIONS, AUDIT_SUBJECTS } from "../audit/audit-actions.js";
import { AuditService } from "../audit/audit.service.js";
import { AuthService } from "../auth/auth.service.js";
import { OnboardingService } from "../onboarding/onboarding.service.js";
import { UsersService, type LoginOpened } from "../users/users.service.js";
import type {
  CreateEmployeeDto,
  OffboardDto,
  ListEmployeesDto,
  OnboardDto,
  UpdateEmployeeDto,
} from "./dto/employee.dto.js";
import {
  checkRepeats,
  checkShape,
  IMPORT_COLUMNS,
  readRows,
  type ImportReport,
  type ImportRow,
  type RowFault,
} from "./import.js";

const UNIQUE_VIOLATION = "P2002";

// A trailing run of digits is what makes a code a series; the width caps it at
// what an int holds, since the answer is read back as one.
const SERIES = /^(.*?)(\d+)$/;
const MAX_SERIES_DIGITS = 9;

export interface SeededLeave {
  code: string;
  year: number;
  entitled: number;
}

/** What joining wrote, and beside it the parts it left alone with a reason. */
export interface Onboarding {
  employeeId: number;
  code: string;
  startDate: string;
  contractId: string | null;
  payId: string | null;
  leaveSeeded: SeededLeave[];
  checklist: { runId: string; tasks: number } | null;
  userId: string | null;
  skipped: string[];
}

const kHalfDay = 2;
const kMsPerDay = 86_400_000;

/** Days earned over the part of the year that is left, rounded to the half
 *  day that leave is counted in (KEHOACH 9.14).
 */
function prorated(daysPerYear: number, start: Date): number {
  const year = start.getUTCFullYear();
  const opens = Date.UTC(year, 0, 1);
  const closes = Date.UTC(year + 1, 0, 1);
  const whole = (closes - opens) / kMsPerDay;
  const left = (closes - Math.max(start.getTime(), opens)) / kMsPerDay;
  return Math.round(((daysPerYear * left) / whole) * kHalfDay) / kHalfDay;
}

/** What leaving leaves behind, so nobody has to remember to go looking. */
export interface Offboarding {
  employeeId: number;
  code: string;
  leaveDate: string;
  assetsOutstanding: { code: string; name: string }[];
  requestsPending: number;
  advancesOutstanding: number;
}
const kWriteChunk = 2_000;
const kTransactionMs = 600_000;
function asDay(value: Date | null): string {
  return value ? value.toISOString().slice(0, 10) : "";
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

// One join rather than a lookup per row: the table shows a department by name.
const EMPLOYEE_VIEW = {
  department: { select: { id: true, code: true, name: true } },
  jobTitle: { select: { id: true, code: true, name: true } },
  manager: { select: { id: true, code: true, fullName: true } },
} as const;

// A manager reads the tree to run its work, not its papers or its pay (KEHOACH 9.4).
const PAPERS = ["dateOfBirth", "nationalId", "taxCode", "socialInsuranceNo", "bankAccount", "bankName"] as const;

/** A row as this viewer may read it; visible is null for the desk, which reads everything. */
function asSeenBy<T extends Employee>(row: T, viewer: Viewer, visible: number[] | null): T {
  if (visible === null || row.id === viewer.employeeId) {
    return row;
  }
  return { ...row, ...Object.fromEntries(PAPERS.map((column) => [column, null])) };
}

@Injectable()
export class EmployeesService {
  constructor(
    private readonly db: PrismaService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly onboarding: OnboardingService,
    private readonly users: UsersService,
    private readonly auth: AuthService,
  ) {}


  /**
   * Two passes over one file, and the same code decides both: a dry run that
   * cannot reach the writes is a dry run that lies about them.
   */
  async importCsv(viewer: Viewer, text: string, apply: boolean): Promise<ImportReport> {
    const read = readRows(text);
    const faults: RowFault[] = [...read.faults];
    read.rows.forEach((row, at) => faults.push(...checkShape(row, at)));
    faults.push(...checkRepeats(read.rows));

    const [departments, titles, people] = await Promise.all([
      this.db.department.findMany({ select: { id: true, code: true } }),
      this.db.jobTitle.findMany({ select: { id: true, code: true } }),
      this.db.employee.findMany({ select: { id: true, code: true } }),
    ]);
    const departmentBy = new Map(departments.map((one) => [one.code, one.id]));
    const titleBy = new Map(titles.map((one) => [one.code, one.id]));
    const personBy = new Map(people.map((one) => [one.code, one.id]));
    // A manager named in the file counts as known, so a whole department can
    // arrive in one upload without ordering the lines by seniority.
    const arriving = new Set(read.rows.map((row) => row.code).filter(Boolean) as string[]);

    read.rows.forEach((row, at) => {
      const line = at + 2;
      if (row.departmentCode && !departmentBy.has(row.departmentCode)) {
        faults.push({ row: line, column: "departmentCode", code: "DEPARTMENT_UNKNOWN", value: row.departmentCode });
      }
      if (row.jobTitleCode && !titleBy.has(row.jobTitleCode)) {
        faults.push({ row: line, column: "jobTitleCode", code: "JOB_TITLE_UNKNOWN", value: row.jobTitleCode });
      }
      if (row.managerCode && !personBy.has(row.managerCode) && !arriving.has(row.managerCode)) {
        faults.push({ row: line, column: "managerCode", code: "MANAGER_UNKNOWN", value: row.managerCode });
      }
    });

    const toUpdate = read.rows.filter((row) => row.code && personBy.has(row.code)).length;
    const report: ImportReport = {
      applied: false,
      rows: read.rows.length,
      toCreate: read.rows.length - toUpdate,
      toUpdate,
      faults: faults.sort((a, b) => a.row - b.row),
    };
    if (!apply || faults.length > 0) {
      return report;
    }
    await this.writeAll(viewer, read.rows, departmentBy, titleBy);
    return { ...report, applied: true };
  }

  private async writeAll(
    viewer: Viewer,
    rows: ImportRow[],
    departmentBy: Map<string, string>,
    titleBy: Map<string, string>,
  ): Promise<void> {
    await this.db.$transaction(
      async (tx) => {
        for (let at = 0; at < rows.length; at += kWriteChunk) {
          await this.writeChunk(tx, viewer, rows.slice(at, at + kWriteChunk), departmentBy, titleBy);
        }
        // Managers are linked once every person in the file exists, so a line
        // may name a manager that arrives later in the same upload.
        const bosses = rows.filter((row) => row.managerCode);
        const touched: number[] = [];
        for (let at = 0; at < bosses.length; at += kWriteChunk) {
          const slice = bosses.slice(at, at + kWriteChunk);
          await tx.$executeRaw`
            UPDATE "Employee" e
               SET "managerId" = boss."id", "updatedAt" = now()
              FROM unnest(${slice.map((row) => row.code as string)}::text[],
                          ${slice.map((row) => row.managerCode as string)}::text[])
                   AS v("code", "bossCode")
              JOIN "Employee" boss ON boss."code" = v."bossCode"
             WHERE e."code" = v."code"
          `;
        }
        if (bosses.length > 0) {
          const moved = await tx.employee.findMany({
            where: { code: { in: bosses.map((row) => row.code as string) } },
            select: { id: true },
          });
          touched.push(...moved.map((one) => one.id));
          await this.scope.assertNoManagerCycle(tx, touched);
        }
        const paid = rows.filter((row) => row.baseSalary && row.insuranceSalary);
        for (let at = 0; at < paid.length; at += kWriteChunk) {
          const slice = paid.slice(at, at + kWriteChunk);
          await tx.$executeRaw`
            INSERT INTO "CompensationRecord" (
              "id", "employeeId", "effectiveFrom", "baseSalary", "insuranceSalary",
              "reason", "createdById", "createdAt")
            SELECT gen_random_uuid(), e."id", v."from"::date,
                   v."base"::numeric, v."insurance"::numeric,
                   'ADJUSTMENT'::"PayReason", ${viewer.userId}, now()
              FROM unnest(${slice.map((row) => row.code as string)}::text[],
                          ${slice.map((row) => row.hireDate ?? todayIso())}::text[],
                          ${slice.map((row) => row.baseSalary as string)}::text[],
                          ${slice.map((row) => row.insuranceSalary as string)}::text[])
                   AS v("code", "from", "base", "insurance")
              JOIN "Employee" e ON e."code" = v."code"
            ON CONFLICT ("employeeId", "effectiveFrom") DO UPDATE SET
              "baseSalary" = EXCLUDED."baseSalary",
              "insuranceSalary" = EXCLUDED."insuranceSalary"
          `;
        }
      },
      { timeout: kTransactionMs, maxWait: kTransactionMs },
    );
    await this.scope.forgetScopes();
  }

  /** One statement for a slice of the file: a round trip per row is what turns
   *  thirty thousand people into a minute of waiting.
   */
  private writeChunk(
    tx: Prisma.TransactionClient,
    viewer: Viewer,
    rows: ImportRow[],
    departmentBy: Map<string, string>,
    titleBy: Map<string, string>,
  ): Promise<number> {
    void viewer;
    return tx.$executeRaw`
      INSERT INTO "Employee" (
        "code", "fullName", "personalEmail", "phone", "dateOfBirth", "gender",
        "nationalId", "taxCode", "socialInsuranceNo", "departmentId", "jobTitleId",
        "hireDate", "active", "locale", "createdAt", "updatedAt")
      SELECT v."code", v."fullName", v."personalEmail", v."phone",
             v."dateOfBirth"::date, v."gender"::"Gender",
             v."nationalId", v."taxCode", v."socialInsuranceNo",
             v."departmentId", v."jobTitleId", v."hireDate"::date,
             true, 'vi', now(), now()
        FROM unnest(
               ${rows.map((row) => row.code as string)}::text[],
               ${rows.map((row) => row.fullName as string)}::text[],
               ${rows.map((row) => row.personalEmail ?? null)}::text[],
               ${rows.map((row) => row.phone ?? null)}::text[],
               ${rows.map((row) => row.dateOfBirth ?? null)}::text[],
               ${rows.map((row) => row.gender ?? null)}::text[],
               ${rows.map((row) => row.nationalId ?? null)}::text[],
               ${rows.map((row) => row.taxCode ?? null)}::text[],
               ${rows.map((row) => row.socialInsuranceNo ?? null)}::text[],
               ${rows.map((row) => (row.departmentCode ? departmentBy.get(row.departmentCode) ?? null : null))}::text[],
               ${rows.map((row) => (row.jobTitleCode ? titleBy.get(row.jobTitleCode) ?? null : null))}::text[],
               ${rows.map((row) => row.hireDate ?? null)}::text[]
             ) AS v("code", "fullName", "personalEmail", "phone", "dateOfBirth",
                    "gender", "nationalId", "taxCode", "socialInsuranceNo",
                    "departmentId", "jobTitleId", "hireDate")
      ON CONFLICT ("code") DO UPDATE SET
        "fullName" = EXCLUDED."fullName",
        "personalEmail" = EXCLUDED."personalEmail",
        "phone" = EXCLUDED."phone",
        "dateOfBirth" = EXCLUDED."dateOfBirth",
        "gender" = EXCLUDED."gender",
        "nationalId" = EXCLUDED."nationalId",
        "taxCode" = EXCLUDED."taxCode",
        "socialInsuranceNo" = EXCLUDED."socialInsuranceNo",
        "departmentId" = EXCLUDED."departmentId",
        "jobTitleId" = EXCLUDED."jobTitleId",
        "hireDate" = EXCLUDED."hireDate",
        "updatedAt" = now()
    `;
  }

  /**
   * The same columns the import reads, filled in. Exporting into a shape the
   * importer will not take back is how a round trip turns into retyping.
   */
  async exportCsv(viewer: Viewer): Promise<string> {
    const visible = await this.scope.visibleEmployeeIds(viewer);
    const rows = await this.db.employee.findMany({
      where: ScopeService.narrow("id", visible),
      include: {
        department: { select: { code: true } },
        jobTitle: { select: { code: true } },
        manager: { select: { code: true } },
        compensation: { orderBy: { effectiveFrom: "desc" }, take: 1 },
      },
      orderBy: { code: "asc" },
    });
    const body = rows.map((one) => [
      one.code,
      one.fullName,
      one.personalEmail ?? "",
      one.phone ?? "",
      asDay(one.dateOfBirth),
      one.gender ?? "",
      one.nationalId ?? "",
      one.taxCode ?? "",
      one.socialInsuranceNo ?? "",
      one.department?.code ?? "",
      one.jobTitle?.code ?? "",
      one.manager?.code ?? "",
      asDay(one.hireDate),
      one.compensation[0]?.baseSalary.toFixed(0) ?? "",
      one.compensation[0]?.insuranceSalary.toFixed(0) ?? "",
    ]);
    return toExcelCsv([...IMPORT_COLUMNS], body);
  }

  async list(query: ListEmployeesDto, viewer: Viewer): Promise<Page<Employee>> {
    const visible = await this.scope.visibleEmployeeIds(viewer);
    const where: Prisma.EmployeeWhereInput = {
      ...ScopeService.narrow("id", visible),
      ...(query.departmentId ? { departmentId: query.departmentId } : {}),
      ...(query.search
        ? {
            OR: [
              { code: { contains: query.search, mode: "insensitive" } },
              { fullName: { contains: query.search, mode: "insensitive" } },
            ],
          }
        : {}),
    };
    // Code is unique, so resuming needs no tiebreak and the comparison stays
    // one index bound (KEHOACH 9.9 rule 3).
    const from = query.cursor ? decodeCursor(query.cursor) : null;
    const resumed: Prisma.EmployeeWhereInput = from
      ? { AND: [where, { code: { gt: from.sortValue } }] }
      : where;
    const [rows, found] = await Promise.all([
      this.db.employee.findMany({
        where: resumed,
        skip: from ? 0 : query.skip,
        take: query.take,
        orderBy: [{ code: "asc" }, { id: "asc" }],
        include: EMPLOYEE_VIEW,
      }),
      this.db.employee.count({ where, take: COUNT_CEILING + 1 }),
    ]);
    return {
      rows: rows.map((row) => asSeenBy(row, viewer, visible)),
      ...countedTo(found),
      next: nextCursor(rows, query.take, (row) => row.code),
    };
  }

  async get(id: number, viewer: Viewer): Promise<Employee> {
    const visible = await this.scope.visibleEmployeeIds(viewer);
    // Out of scope answers the same as absent: 403 would confirm they exist.
    if (visible !== null && !visible.includes(id)) {
      throw new NotFoundException("EMPLOYEE_NOT_FOUND");
    }
    const found = await this.db.employee.findUnique({ where: { id }, include: EMPLOYEE_VIEW });
    if (!found) {
      throw new NotFoundException("EMPLOYEE_NOT_FOUND");
    }
    return asSeenBy(found, viewer, visible);
  }

  /**
   * A starting point for the code field, never a reservation: the unique index
   * is what actually settles a clash, and two people opening the form at once
   * are both handed the same answer.
   */
  async nextCode(): Promise<{ code: string | null }> {
    const [last] = await this.db.employee.findMany({
      orderBy: { createdAt: "desc" },
      select: { code: true },
      take: 1,
    });
    const series = SERIES.exec(last?.code ?? "");
    if (!series) {
      return { code: null };
    }
    const [, prefix, digits] = series;
    const start = prefix.length + 1;
    // substr, not substring: a bound parameter makes "substring(x from $1)"
    // resolve to the regex overload, which reads the offset as a pattern.
    const [top] = await this.db.$queryRaw<{ n: number | null }[]>`
      SELECT max(substr(code, ${start})::bigint)::int AS n
      FROM "Employee"
      WHERE left(code, ${prefix.length}) = ${prefix}
        AND substr(code, ${start}) ~ ${`^[0-9]{1,${MAX_SERIES_DIGITS}}$`}
    `;
    if (top?.n === null || top?.n === undefined) {
      return { code: null };
    }
    return { code: `${prefix}${String(top.n + 1).padStart(digits.length, "0")}` };
  }

  async create(viewer: Viewer, body: CreateEmployeeDto): Promise<Employee> {
    try {
      const made = await this.db.employee.create({ data: dated(body) });
      await this.audit.record({
        actorId: viewer.userId,
        action: AUDIT_ACTIONS.EMPLOYEE_CREATE,
        subject: AUDIT_SUBJECTS.EMPLOYEE,
        subjectId: String(made.id),
        meta: { code: made.code },
      });
      return made;
    } catch (error) {
      if (isCode(error, UNIQUE_VIOLATION)) {
        throw new ConflictException("EMPLOYEE_CODE_TAKEN");
      }
      throw error;
    }
  }

  /**
   * Leaving is one move, not seven places to click: the record closes, the
   * login dies at once, and what they still hold comes back as a list
   * somebody has to work through (KEHOACH 9.14).
   */
  /**
   * Joining, with the same shape as leaving: one pass, a report of what it
   * wrote and what it left alone, and safe to run again (KEHOACH 9.14).
   */
  async onboard(viewer: Viewer, id: number, body: OnboardDto): Promise<Onboarding> {
    const person = await this.db.employee.findUnique({
      where: { id },
      select: {
        id: true,
        code: true,
        jobTitleId: true,
        departmentId: true,
        managerId: true,
        leaveDate: true,
      },
    });
    if (!person) {
      throw new NotFoundException("EMPLOYEE_NOT_FOUND");
    }
    if (person.leaveDate) {
      throw new ConflictException("EMPLOYEE_HAS_LEFT");
    }
    const start = new Date(body.contract.startDate);
    const skipped: string[] = [];

    const written = await this.db.$transaction(async (tx) => {
      const contractId = await this.writeContract(tx, person.id, body.contract, skipped);
      const payId = await this.writePay(tx, person.id, start, body.pay, skipped);
      const leaveSeeded =
        body.seedLeave === false ? [] : await this.seedLeave(tx, person.id, start);
      const checklist =
        body.startChecklist === false
          ? null
          : await this.onboarding.plantIn(tx, person, "ONBOARDING", start);
      return { contractId, payId, leaveSeeded, checklist };
    });
    if (body.startChecklist !== false && !written.checklist) {
      skipped.push("NO_CHECKLIST_TEMPLATE_OR_ALREADY_STARTED");
    }

    // Outside the transaction on purpose: the letter must not go out for a
    // pass that rolls back, and a login opened without one is re-invited.
    let login: LoginOpened | null = null;
    if (body.openLogin !== false) {
      login = await this.users.openFor(person.id);
      if (login.skipped) {
        skipped.push(login.skipped);
      }
    }

    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.EMPLOYEE_ONBOARD,
      subject: AUDIT_SUBJECTS.EMPLOYEE,
      subjectId: String(person.id),
      meta: { code: person.code, startDate: body.contract.startDate, skipped },
    });
    return {
      employeeId: person.id,
      code: person.code,
      startDate: body.contract.startDate,
      contractId: written.contractId,
      payId: written.payId,
      leaveSeeded: written.leaveSeeded,
      checklist: written.checklist,
      userId: login?.userId ?? null,
      skipped,
    };
  }

  private async writeContract(
    tx: Prisma.TransactionClient,
    employeeId: number,
    body: OnboardDto["contract"],
    skipped: string[],
  ): Promise<string | null> {
    const startDate = new Date(body.startDate);
    const held = await tx.employmentContract.findFirst({
      where: { employeeId, startDate },
      select: { id: true },
    });
    if (held) {
      skipped.push("CONTRACT_EXISTS");
      return held.id;
    }
    // DRAFT, because the onboarding list carries the task of signing it and
    // only an activation stamps signedAt (KEHOACH 9.14).
    const made = await tx.employmentContract.create({
      data: {
        employeeId,
        kind: body.kind,
        startDate,
        endDate: body.endDate ? new Date(body.endDate) : null,
        probationEnd: body.probationEnd ? new Date(body.probationEnd) : null,
        number: body.number ?? null,
      },
      select: { id: true },
    });
    return made.id;
  }

  private async writePay(
    tx: Prisma.TransactionClient,
    employeeId: number,
    effectiveFrom: Date,
    pay: OnboardDto["pay"],
    skipped: string[],
  ): Promise<string | null> {
    if (!pay) {
      skipped.push("NO_PAY_GIVEN");
      return null;
    }
    const held = await tx.compensationRecord.findUnique({
      where: { employeeId_effectiveFrom: { employeeId, effectiveFrom } },
      select: { id: true },
    });
    if (held) {
      skipped.push("PAY_EXISTS");
      return held.id;
    }
    const made = await tx.compensationRecord.create({
      data: {
        employeeId,
        effectiveFrom,
        baseSalary: pay.baseSalary,
        insuranceSalary: pay.insuranceSalary,
        reason: "HIRE",
      },
      select: { id: true },
    });
    return made.id;
  }

  private async seedLeave(
    tx: Prisma.TransactionClient,
    employeeId: number,
    start: Date,
  ): Promise<SeededLeave[]> {
    const year = start.getUTCFullYear();
    const types = await tx.leaveType.findMany({
      where: { active: true },
      select: { id: true, code: true, daysPerYear: true },
    });
    const held = await tx.leaveBalance.findMany({
      where: { employeeId, year },
      select: { leaveTypeId: true },
    });
    const already = new Set(held.map((one) => one.leaveTypeId));
    const fresh = types
      .filter((one) => !already.has(one.id))
      .map((one) => ({
        leaveTypeId: one.id,
        code: one.code,
        entitled: prorated(Number(one.daysPerYear), start),
      }));
    if (fresh.length === 0) {
      return [];
    }
    await tx.leaveBalance.createMany({
      data: fresh.map((one) => ({
        employeeId,
        leaveTypeId: one.leaveTypeId,
        year,
        entitled: one.entitled,
      })),
    });
    return fresh.map((one) => ({ code: one.code, year, entitled: one.entitled }));
  }

  async offboard(viewer: Viewer, id: number, body: OffboardDto): Promise<Offboarding> {
    const person = await this.get(id, viewer);
    const leaveDate = new Date(body.leaveDate);
    await this.db.$transaction(async (tx) => {
      await tx.employee.update({ where: { id }, data: { leaveDate, active: false } });
      await tx.user.updateMany({ where: { employeeId: id }, data: { active: false } });
      await tx.session.updateMany({
        where: { user: { employeeId: id }, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
    const logins = await this.db.user.findMany({ where: { employeeId: id }, select: { id: true } });
    await this.auth.cutAccess(logins.map((one) => one.id));
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.EMPLOYEE_OFFBOARD,
      subject: AUDIT_SUBJECTS.EMPLOYEE,
      subjectId: String(id),
      meta: { code: person.code, leaveDate: body.leaveDate, reason: body.reason },
    });

    const [assets, requests, advances] = await Promise.all([
      this.db.asset.findMany({
        where: { holderId: id, state: "ISSUED" },
        select: { code: true, name: true },
        orderBy: { code: "asc" },
      }),
      this.db.request.count({ where: { employeeId: id, state: "PENDING" } }),
      this.db.salaryAdvance.count({ where: { employeeId: id, state: "PAID" } }),
    ]);
    return {
      employeeId: id,
      code: person.code,
      leaveDate: body.leaveDate,
      assetsOutstanding: assets,
      requestsPending: requests,
      advancesOutstanding: advances,
    };
  }

  async update(id: number, body: UpdateEmployeeDto, viewer: Viewer): Promise<Employee> {
    await this.get(id, viewer);
    try {
      const saved = await this.db.$transaction(async (tx) => {
        const row = await tx.employee.update({ where: { id }, data: dated(body) });
        if (body.managerId !== undefined) {
          await this.scope.assertNoManagerCycle(tx, [id]);
        }
        return row;
      });
      if (body.managerId !== undefined) {
        await this.scope.forgetScopes();
      }
      // Field names only: a second copy of personal data is a second place the
      // right to erasure has to reach (KEHOACH 9.24 rule 4).
      await this.audit.record({
        actorId: viewer.userId,
        action: AUDIT_ACTIONS.EMPLOYEE_UPDATE,
        subject: AUDIT_SUBJECTS.EMPLOYEE,
        subjectId: String(id),
        meta: {
          fields: Object.entries(body)
            .filter(([, value]) => value !== undefined)
            .map(([field]) => field)
            .sort(),
        },
      });
      return saved;
    } catch (error) {
      if (isCode(error, UNIQUE_VIOLATION)) {
        throw new ConflictException("EMPLOYEE_CODE_TAKEN");
      }
      throw error;
    }
  }

  /** Retire an employee without erasing them: attendance rows point here, and
   *  someone who left still has a history. E11-T6 turns this into a roster
   *  push that reaches the kiosks (KEHOACH 7.5).
   */
  async deactivate(id: number, viewer: Viewer): Promise<Employee> {
    await this.get(id, viewer);
    const closed = await this.db.employee.update({ where: { id }, data: { active: false } });
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.EMPLOYEE_DEACTIVATE,
      subject: AUDIT_SUBJECTS.EMPLOYEE,
      subjectId: String(id),
      meta: { code: closed.code },
    });
    return closed;
  }
}

// The dto carries ISO days because that is what a form sends; the column is a
// date, and Prisma wants the object.
function dated<T extends { hireDate?: string; dateOfBirth?: string }>(body: T) {
  return {
    ...body,
    ...(body.hireDate ? { hireDate: new Date(body.hireDate) } : {}),
    ...(body.dateOfBirth ? { dateOfBirth: new Date(body.dateOfBirth) } : {}),
  };
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
