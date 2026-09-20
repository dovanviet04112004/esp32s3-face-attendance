import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { Employee, Prisma } from "@prisma/client";

import type { Page } from "../../common/dto/pagination.dto.js";
import { ScopeService } from "../../common/scope/scope.service.js";
import type { Viewer } from "../../common/scope/viewer.js";
import { toExcelCsv } from "../../common/csv.js";
import { PrismaService } from "../../database/prisma.service.js";
import { AuditService } from "../audit/audit.service.js";
import type {
  CreateEmployeeDto,
  OffboardDto,
  ListEmployeesDto,
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

@Injectable()
export class EmployeesService {
  constructor(
    private readonly db: PrismaService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
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
    const [rows, total] = await Promise.all([
      this.db.employee.findMany({
        where,
        skip: query.skip,
        take: query.take,
        orderBy: { code: "asc" },
        include: EMPLOYEE_VIEW,
      }),
      this.db.employee.count({ where }),
    ]);
    return { rows, total };
  }

  async get(id: number, viewer: Viewer): Promise<Employee> {
    const visible = await this.scope.visibleEmployeeIds(viewer);
    // Out of scope answers the same as absent: 403 would confirm they exist.
    if (visible !== null && !visible.includes(id)) {
      throw new NotFoundException(`no employee ${id}`);
    }
    const found = await this.db.employee.findUnique({ where: { id }, include: EMPLOYEE_VIEW });
    if (!found) {
      throw new NotFoundException(`no employee ${id}`);
    }
    return found;
  }

  async create(body: CreateEmployeeDto): Promise<Employee> {
    try {
      return await this.db.employee.create({ data: dated(body) });
    } catch (error) {
      if (isCode(error, UNIQUE_VIOLATION)) {
        throw new ConflictException(`employee code ${body.code} is taken`);
      }
      throw error;
    }
  }

  /**
   * Leaving is one move, not seven places to click: the record closes, the
   * login dies at once, and what they still hold comes back as a list
   * somebody has to work through (KEHOACH 9.14).
   */
  async offboard(viewer: Viewer, id: number, body: OffboardDto): Promise<Offboarding> {
    const person = await this.get(id, viewer);
    const leaveDate = new Date(body.leaveDate);
    await this.db.$transaction(async (tx) => {
      await tx.employee.update({ where: { id }, data: { leaveDate, active: false } });
      await tx.user.updateMany({
        where: { employeeId: id },
        data: { active: false, refreshTokenHash: null },
      });
    });
    await this.audit.record({
      action: "employee.offboard",
      target: person.code,
      meta: { by: viewer.userId, leaveDate: body.leaveDate, reason: body.reason },
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
      return saved;
    } catch (error) {
      if (isCode(error, UNIQUE_VIOLATION)) {
        throw new ConflictException(`employee code ${body.code} is taken`);
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
    return this.db.employee.update({ where: { id }, data: { active: false } });
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
