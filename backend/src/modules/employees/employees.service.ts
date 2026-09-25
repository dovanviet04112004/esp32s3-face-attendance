import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  PayloadTooLargeException,
  type OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma, type Employee } from "@prisma/client";

import { COUNT_CEILING, countedTo, decodeCursor, nextCursor } from "../../common/dto/cursor.dto.js";
import type { Page } from "../../common/dto/pagination.dto.js";
import { ScopeService } from "../../common/scope/scope.service.js";
import type { Viewer } from "../../common/scope/viewer.js";
import { toExcelCsv } from "../../common/csv.js";
import type { Env } from "../../config/env.schema.js";
import { PrismaService } from "../../database/prisma.service.js";
import { QUEUE_TOKEN, type Queues } from "../../queue/queue.module.js";
import { JOB, QUEUE, type PasswordSetupJob } from "../../queue/queues.js";
import { AUDIT_ACTIONS, AUDIT_SUBJECTS } from "../audit/audit-actions.js";
import { AuditService } from "../audit/audit.service.js";
import { AuthService } from "../auth/auth.service.js";
import { departmentSubtree } from "../../common/scope/department-subtree.js";
import { ConsentService } from "../enrollment/consent.service.js";
import { EnrollmentService } from "../enrollment/enrollment.service.js";
import { OnboardingService } from "../onboarding/onboarding.service.js";
import { dayAsDate, localDay } from "../timesheet/local-day.js";
import { UsersService, type LoginOpened, type RoleFlip } from "../users/users.service.js";
import {
  ENDING_WINDOW_DAYS,
  type CreateEmployeeDto,
  type EmployeeFilterDto,
  type MoveLeavingDto,
  type OffboardDto,
  type ListEmployeesDto,
  type OnboardDto,
  type UpdateEmployeeDto,
} from "./dto/employee.dto.js";
import {
  CHANGES_LISTED,
  CLEAR,
  checkRepeats,
  checkShape,
  csvLines,
  ENTRY_SEPARATOR,
  FLAGS,
  GENDERS,
  IMPORT_COLUMNS,
  IMPORT_MAX_ROWS,
  planRows,
  readLines,
  type Catalogue,
  type Held,
  type HeldColumn,
  type ImportColumn,
  type ImportReport,
  type ImportRow,
  type ImportUpload,
  type RowFault,
  type RowPlan,
} from "./import.js";
import { readWorkbook, writeWorkbook, XLSX_MIME } from "./workbook.js";

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
  closed: boolean;
  assetsOutstanding: { code: string; name: string }[];
  requestsPending: number;
  advancesOutstanding: number;
}
const kWriteChunk = 2_000;
const kTransactionMs = 600_000;
// Read in APP_TIMEZONE: the first minutes of the day after a last day (KEHOACH 9.14).
const kLeavingsCron = "5 0 * * *";
function asDay(value: Date | null): string {
  return value ? value.toISOString().slice(0, 10) : "";
}

function earliestDay(days: (Date | null)[]): string {
  const known = days.filter((one): one is Date => one !== null).map((one) => one.toISOString().slice(0, 10));
  return known.sort()[0] ?? "";
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function dayBefore(day: string): string {
  return new Date(dayAsDate(day).getTime() - kMsPerDay).toISOString().slice(0, 10);
}

// One join rather than a lookup per row: the table shows a department by name.
const EMPLOYEE_VIEW = {
  department: { select: { id: true, code: true, name: true } },
  jobTitle: { select: { id: true, code: true, name: true } },
  manager: { select: { id: true, code: true, fullName: true } },
} as const;

// A manager reads the tree to run its work, not its papers or its pay (KEHOACH 9.4).
const PAPERS = ["dateOfBirth", "nationalId", "taxCode", "socialInsuranceNo", "bankAccount", "bankName"] as const;

// Column in the file, in the table, and its cast; email and bank move only by request (KEHOACH 9.17 item 6).
const RECORD_COLUMNS: readonly (readonly [ImportColumn, string, string])[] = [
  ["fullName", "fullName", ""],
  ["phone", "phone", ""],
  ["dateOfBirth", "dateOfBirth", "::date"],
  ["gender", "gender", '::"Gender"'],
  ["nationalId", "nationalId", ""],
  ["taxCode", "taxCode", ""],
  ["socialInsuranceNo", "socialInsuranceNo", ""],
  ["hireDate", "hireDate", "::date"],
  ["legalEntityCode", "legalEntityId", ""],
  ["departmentCode", "departmentId", ""],
  ["jobTitleCode", "jobTitleId", ""],
];

/** One cell of an update: null keeps the column, "" empties it, anything else is written (KEHOACH 9.20 rule 4). */
function slotOf(plan: RowPlan, column: ImportColumn): string | null {
  if (plan.cleared.includes(column)) {
    return "";
  }
  if (!plan.fields.includes(column)) {
    return null;
  }
  switch (column) {
    case "legalEntityCode":
      return plan.place.legalEntityId;
    case "departmentCode":
      return plan.place.departmentId;
    case "jobTitleCode":
      return plan.place.jobTitleId;
    default:
      return plan.row[column] ?? null;
  }
}

// A made-up person: the line only has to show the format of each column.
const TEMPLATE_SAMPLE: Omit<
  Record<ImportColumn, string>,
  "hireDate" | "legalEntityCode" | "departmentCode" | "jobTitleCode" | "shiftName" | "shiftFrom"
> = {
  code: "NV9999",
  fullName: "Nguyễn Văn Mẫu",
  personalEmail: "nguyen.van.mau@example.com",
  phone: "0900000000",
  dateOfBirth: "1995-04-30",
  gender: "MALE",
  nationalId: "001095000000",
  taxCode: "8000000000",
  socialInsuranceNo: "0100000000",
  managerCode: "",
  baseSalary: "15000000",
  insuranceSalary: "15000000",
  bankAccount: "0000000000",
  bankName: "Ngân hàng A",
  consentPaper: "NO",
  kioskId: "",
  openLogin: "NO",
};

interface HeldPlace {
  legalEntityId: string | null;
  departmentId: string | null;
}

export type FileFormat = "xlsx" | "csv";

/** A file to hand back, typed and named for the download. */
export interface FileOut {
  body: Buffer;
  type: string;
  name: string;
}

const CSV_TYPE = "text/csv; charset=utf-8";

// Everything the dry run compares a line with, in one read per slice of the file.
const HELD = {
  id: true,
  code: true,
  active: true,
  locale: true,
  fullName: true,
  phone: true,
  dateOfBirth: true,
  gender: true,
  nationalId: true,
  taxCode: true,
  socialInsuranceNo: true,
  hireDate: true,
  personalEmail: true,
  bankAccount: true,
  bankName: true,
  legalEntityId: true,
  departmentId: true,
  jobTitleId: true,
  manager: { select: { code: true } },
  login: { select: { id: true } },
  shifts: { select: { shiftId: true, validFrom: true } },
  enrollments: { select: { deviceId: true, state: true } },
  _count: { select: { compensation: true, consents: { where: { state: "GRANTED" } } } },
} satisfies Prisma.EmployeeSelect;

/** The profile columns as the export writes them, which is what a re-import is compared with. */
function profileOf(one: Pick<Employee, HeldColumn>): Record<HeldColumn, string> {
  return {
    fullName: one.fullName,
    phone: one.phone ?? "",
    dateOfBirth: asDay(one.dateOfBirth),
    gender: one.gender ?? "",
    nationalId: one.nationalId ?? "",
    taxCode: one.taxCode ?? "",
    socialInsuranceNo: one.socialInsuranceNo ?? "",
    hireDate: asDay(one.hireDate),
    personalEmail: one.personalEmail ?? "",
    bankAccount: one.bankAccount ?? "",
    bankName: one.bankName ?? "",
  };
}

function heldOf(one: Prisma.EmployeeGetPayload<{ select: typeof HELD }>): Held {
  return {
    id: one.id,
    active: one.active,
    locale: one.locale,
    values: profileOf(one),
    legalEntityId: one.legalEntityId,
    departmentId: one.departmentId,
    jobTitleId: one.jobTitleId,
    managerCode: one.manager?.code ?? "",
    hasPay: one._count.compensation > 0,
    hasLogin: one.login !== null,
    consented: one._count.consents > 0,
    shifts: new Set(one.shifts.map((held) => `${held.shiftId}/${asDay(held.validFrom)}`)),
    kiosks: new Map(one.enrollments.map((pair) => [pair.deviceId, pair.state])),
  };
}

function chunks<T>(items: readonly T[]): T[][] {
  const cut: T[][] = [];
  for (let at = 0; at < items.length; at += kWriteChunk) {
    cut.push(items.slice(at, at + kWriteChunk));
  }
  return cut;
}

// A held face first, then a pair still waiting for one.
const STANDING_ORDER: Readonly<Record<string, number>> = { ENROLLED: 0, RETAKE: 1, ASSIGNED: 2 };

async function managersOf(tx: Prisma.TransactionClient, codes: string[]): Promise<Map<number, number | null>> {
  const rows = await tx.$queryRaw<{ id: number; managerId: number | null }[]>`
    SELECT "id", "managerId" FROM "Employee" WHERE "code" = ANY(${codes}::text[])
  `;
  return new Map(rows.map((one) => [one.id, one.managerId]));
}

/** New people, one statement per slice: a round trip per row turns thirty thousand into a minute of waiting. */
function insertNew(tx: Prisma.TransactionClient, plans: RowPlan[]): Promise<number> {
  const rows = plans.map((one) => one.row);
  const placed = plans.map((one) => one.place);
  return tx.$executeRaw`
    INSERT INTO "Employee" (
      "code", "fullName", "personalEmail", "phone", "dateOfBirth", "gender",
      "nationalId", "taxCode", "socialInsuranceNo", "legalEntityId", "departmentId", "jobTitleId",
      "hireDate", "bankAccount", "bankName", "active", "locale", "createdAt", "updatedAt")
    SELECT v."code", v."fullName", v."personalEmail", v."phone",
           v."dateOfBirth"::date, v."gender"::"Gender",
           v."nationalId", v."taxCode", v."socialInsuranceNo",
           v."legalEntityId", v."departmentId", v."jobTitleId", v."hireDate"::date,
           v."bankAccount", v."bankName", true, 'vi', now(), now()
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
             ${placed.map((spot) => spot.legalEntityId)}::text[],
             ${placed.map((spot) => spot.departmentId)}::text[],
             ${placed.map((spot) => spot.jobTitleId)}::text[],
             ${rows.map((row) => row.hireDate ?? null)}::text[],
             ${rows.map((row) => row.bankAccount ?? null)}::text[],
             ${rows.map((row) => row.bankName ?? null)}::text[]
           ) AS v("code", "fullName", "personalEmail", "phone", "dateOfBirth",
                  "gender", "nationalId", "taxCode", "socialInsuranceNo",
                  "legalEntityId", "departmentId", "jobTitleId", "hireDate",
                  "bankAccount", "bankName")
    ON CONFLICT ("code") DO NOTHING
  `;
}

/** People already here: each cell keeps, empties or writes its column, as slotOf read it. */
function updateHeld(tx: Prisma.TransactionClient, plans: RowPlan[]): Promise<number> {
  const slots = RECORD_COLUMNS.map(([column]) => Prisma.sql`${plans.map((one) => slotOf(one, column))}::text[]`);
  const names = Prisma.raw(RECORD_COLUMNS.map(([, target]) => `"${target}"`).join(", "));
  const writes = Prisma.raw(
    RECORD_COLUMNS.map(
      ([, target, cast]) =>
        `"${target}" = CASE WHEN v."${target}" IS NULL THEN e."${target}" ELSE NULLIF(v."${target}", '')${cast} END`,
    ).join(", "),
  );
  return tx.$executeRaw`
    UPDATE "Employee" e SET ${writes}, "updatedAt" = now()
      FROM unnest(${plans.map((one) => one.row.code as string)}::text[], ${Prisma.join(slots)}) AS v("code", ${names})
     WHERE e."code" = v."code"
  `;
}

async function idsOf(tx: Prisma.TransactionClient, codes: string[]): Promise<Map<string, number>> {
  const rows = await tx.$queryRaw<{ id: number; code: string }[]>`
    SELECT "id", "code" FROM "Employee" WHERE "code" = ANY(${codes}::text[])
  `;
  return new Map(rows.map((one) => [one.code, one.id]));
}

// Only a shift, person and start that is not there yet: the same file twice adds nothing (KEHOACH 9.20 rule 3).
async function writeShifts(tx: Prisma.TransactionClient, plans: RowPlan[], ids: ReadonlyMap<string, number>): Promise<void> {
  const data = plans.flatMap((one) => {
    const employeeId = ids.get(one.row.code as string);
    return one.shift && employeeId !== undefined
      ? [{ shiftId: one.shift.shiftId, employeeId, validFrom: dayAsDate(one.shift.validFrom) }]
      : [];
  });
  for (const slice of chunks(data)) {
    await tx.shiftAssignment.createMany({ data: slice, skipDuplicates: true });
  }
}

/** Pending requests follow their person to the new manager, as a reorganisation moves them (KEHOACH 9.4). */
export function repointPending(tx: Prisma.TransactionClient, employeeIds: number[]): Promise<number> {
  return tx.$executeRaw`
    UPDATE "Request" r
       SET "approverId" = e."managerId", "updatedAt" = now()
      FROM "Employee" e
     WHERE r."employeeId" = e."id"
       AND r."state" = 'PENDING'
       AND e."id" = ANY(${employeeIds}::int[])
       AND r."approverId" IS DISTINCT FROM e."managerId"
  `;
}

/** A row as this viewer may read it; visible is null for the desk, which reads everything. */
function asSeenBy<T extends Employee>(row: T, viewer: Viewer, visible: number[] | null): T {
  if (visible === null || row.id === viewer.employeeId) {
    return row;
  }
  return { ...row, ...Object.fromEntries(PAPERS.map((column) => [column, null])) };
}

@Injectable()
export class EmployeesService implements OnModuleInit {
  constructor(
    private readonly db: PrismaService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly onboarding: OnboardingService,
    private readonly users: UsersService,
    private readonly auth: AuthService,
    private readonly enrollment: EnrollmentService,
    private readonly consent: ConsentService,
    private readonly config: ConfigService<Env, true>,
    @Inject(QUEUE_TOKEN) private readonly queues: Queues,
  ) {}

  // Upserting by scheduler id: a restart re-states it, never adds a second.
  async onModuleInit(): Promise<void> {
    await this.queues[QUEUE.people].upsertJobScheduler(
      "leavings-due-daily",
      { pattern: kLeavingsCron, tz: this.config.get("APP_TIMEZONE", { infer: true }) },
      { name: JOB.leavingsDue, data: { type: JOB.leavingsDue } },
    );
  }


  /** Dry run by default; `apply` writes only a file with no fault left (KEHOACH 9.20). */
  async importFile(viewer: Viewer, upload: ImportUpload, apply: boolean): Promise<ImportReport> {
    const read = readLines(upload.kind === "xlsx" ? await readWorkbook(upload.bytes) : csvLines(upload.text));
    if (read.rows.length > IMPORT_MAX_ROWS) {
      throw new PayloadTooLargeException("IMPORT_TOO_MANY_ROWS");
    }
    const faults: RowFault[] = [...read.faults];
    read.rows.forEach((row, at) => faults.push(...checkShape(row, read.lines[at] ?? 0)));
    faults.push(...checkRepeats(read.rows, read.lines));

    const codes = [...new Set(read.rows.flatMap((row) => (row.code ? [row.code] : [])))];
    const bosses = [
      ...new Set(read.rows.flatMap((row) => (row.managerCode && row.managerCode !== CLEAR ? [row.managerCode] : []))),
    ];
    const [catalogue, heldBy, managers] = await Promise.all([
      this.catalogueNow(),
      this.heldFor(codes),
      this.codesAmong(bosses),
    ]);
    const asking = read.rows
      .filter((row) => row.openLogin === "YES")
      .flatMap((row) => heldBy.get(row.code ?? "")?.values.personalEmail || row.personalEmail || []);
    const planned = planRows({
      read,
      catalogue,
      heldBy,
      managers,
      takenEmails: await this.loginEmailsAmong(asking),
      today: this.today(),
    });
    faults.push(...planned.faults);
    const { plans } = planned;
    const changing = plans.filter((one) => one.held && one.fields.length + one.cleared.length > 0);
    const created = plans.filter((one) => !one.held).length;
    const report: ImportReport = {
      applied: false,
      rows: plans.length,
      toCreate: created,
      toUpdate: changing.length,
      unchanged: plans.length - created - changing.length,
      payKept: planned.payKept,
      shiftsToAssign: plans.filter((one) => one.shift).length,
      consentsToRecord: plans.filter((one) => one.consent).length,
      kiosksToAssign: plans.filter((one) => one.kiosk).length,
      loginsToOpen: plans.filter((one) => one.login).length,
      changes: changing
        .slice(0, CHANGES_LISTED)
        .map((one) => ({ row: one.line, code: one.row.code as string, fields: one.fields, cleared: one.cleared })),
      faults: faults.sort((a, b) => a.row - b.row),
      warnings: planned.warnings.sort((a, b) => a.row - b.row),
    };
    if (!apply || faults.length > 0) {
      return report;
    }
    await this.writeAll(viewer, plans);
    return { ...report, applied: true };
  }

  /** One transaction for every write; the letters, the kiosk messages and the trail follow its commit (KEHOACH 9.20). */
  private async writeAll(viewer: Viewer, plans: RowPlan[]): Promise<void> {
    const rows = plans.map((one) => one.row);
    const codes = rows.map((row) => row.code as string);
    // An empty manager cell keeps the manager; only a named one or a "-" moves it.
    const bossed = plans
      .filter((one) => one.row.managerCode !== undefined || one.cleared.includes("managerCode"))
      .map((one) => ({ code: one.row.code, managerCode: one.cleared.includes("managerCode") ? undefined : one.row.managerCode }));
    const written = await this.db.$transaction(
      async (tx) => {
        const before = await managersOf(tx, codes);
        const arriving = plans.filter((one) => !one.held);
        let inserted = 0;
        for (const slice of chunks(arriving)) {
          inserted += await insertNew(tx, slice);
        }
        if (inserted !== arriving.length) {
          throw new ConflictException("EMPLOYEE_CODE_TAKEN");
        }
        for (const slice of chunks(plans.filter((one) => one.held && one.writesRecord))) {
          await updateHeld(tx, slice);
        }
        const flips = bossed.length > 0 ? await this.linkManagers(tx, bossed, bossed.map((one) => one.code as string), before) : [];
        for (const slice of chunks(rows.filter((row) => row.baseSalary && row.insuranceSalary))) {
          await this.seedPay(tx, viewer, slice);
        }
        const ids = await idsOf(tx, codes);
        await writeShifts(tx, plans, ids);
        const consented = await this.consent.stageGrants(
          tx,
          viewer.userId,
          plans.flatMap((one) => (one.consent ? [ids.get(one.row.code as string) ?? 0] : [])),
          "PAPER",
        );
        return { flips, ids, consented: new Set(consented), ...(await this.stageLogins(tx, plans, ids)) };
      },
      { timeout: kTransactionMs, maxWait: kTransactionMs },
    );
    await this.scope.forgetScopes();
    await this.users.settleRoleFlips(viewer.userId, written.flips);
    await this.users.mailSetups(written.jobs);
    const seated = await this.seatOnKiosks(plans, written.ids);
    const landed = (id: number, field: ImportColumn) =>
      (field !== "kioskId" || seated.has(id)) &&
      (field !== "openLogin" || written.opened.has(id)) &&
      (field !== "consentPaper" || written.consented.has(id));
    const trail = plans.flatMap((one) => {
      const code = one.row.code as string;
      const id = written.ids.get(code);
      const fields = one.fields.filter((field) => landed(id ?? 0, field));
      if (id === undefined || (one.held && fields.length + one.cleared.length === 0)) {
        return [];
      }
      return [
        {
          actorId: viewer.userId,
          action: one.held ? AUDIT_ACTIONS.EMPLOYEE_UPDATE : AUDIT_ACTIONS.EMPLOYEE_CREATE,
          subject: AUDIT_SUBJECTS.EMPLOYEE,
          subjectId: String(id),
          meta: { code, fields, cleared: one.cleared, source: "import" },
        },
      ];
    });
    for (const slice of chunks([...trail, ...this.consent.grantTrail(viewer.userId, [...written.consented], "PAPER")])) {
      await this.audit.recordMany(slice);
    }
  }

  // Inside the import's transaction, so a pass that rolls back leaves no login behind.
  private async stageLogins(
    tx: Prisma.TransactionClient,
    plans: RowPlan[],
    ids: ReadonlyMap<string, number>,
  ): Promise<{ jobs: PasswordSetupJob[]; opened: Set<number> }> {
    const jobs: PasswordSetupJob[] = [];
    const opened = new Set<number>();
    const wanted = plans.flatMap((one) => (one.login ? [ids.get(one.row.code as string) ?? 0] : []));
    for (const slice of chunks(wanted)) {
      const people = await tx.employee.findMany({
        where: { id: { in: slice }, login: null, personalEmail: { not: null } },
        select: { id: true, personalEmail: true, locale: true, _count: { select: { reports: { where: { active: true } } } } },
      });
      const staged = await this.users.stageSetups(
        tx,
        people.map((one) => ({
          employeeId: one.id,
          email: one.personalEmail as string,
          locale: one.locale,
          manages: one._count.reports > 0,
        })),
        [],
      );
      jobs.push(...staged.jobs);
      staged.opened.forEach((_, employeeId) => opened.add(employeeId));
    }
    return { jobs, opened };
  }

  /** One roster bump per kiosk for the whole file (KEHOACH 7.5); answers who landed on one. */
  private async seatOnKiosks(plans: RowPlan[], ids: ReadonlyMap<string, number>): Promise<Set<number>> {
    const byKiosk = new Map<string, { id: number; code: string; fullName: string }[]>();
    for (const one of plans) {
      const id = ids.get(one.row.code as string);
      if (one.kiosk && id !== undefined) {
        const seats = byKiosk.get(one.kiosk) ?? [];
        seats.push({ id, code: one.row.code as string, fullName: one.row.fullName as string });
        byKiosk.set(one.kiosk, seats);
      }
    }
    const seated = new Set<number>();
    for (const [deviceId, people] of byKiosk) {
      const put = await this.enrollment.assignMany(deviceId, people);
      put.versions.forEach((_, employeeId) => seated.add(employeeId));
    }
    return seated;
  }

  /** Every catalogue entry by the key a file names it with, retired ones included (KEHOACH 9.20 rule 2). */
  private async catalogueNow(): Promise<Catalogue> {
    const [entities, departments, titles, shifts, kiosks] = await Promise.all([
      this.db.legalEntity.findMany({ select: { id: true, code: true, active: true } }),
      this.db.department.findMany({ select: { id: true, code: true, legalEntityId: true, active: true } }),
      this.db.jobTitle.findMany({ select: { id: true, code: true, active: true } }),
      this.db.shift.findMany({ select: { id: true, name: true, active: true } }),
      this.enrollment.assignable(),
    ]);
    const live = entities.filter((one) => one.active);
    return {
      entities: new Map(entities.map((one) => [one.code, { id: one.id, active: one.active }])),
      onlyEntity: live.length === 1 ? (live[0]?.id ?? null) : null,
      departments: new Map(
        departments.map((one) => [`${one.legalEntityId}/${one.code}`, { id: one.id, active: one.active }]),
      ),
      departmentCodes: new Set(departments.map((one) => one.code)),
      entityOfDepartment: new Map(departments.map((one) => [one.id, one.legalEntityId])),
      titles: new Map(titles.map((one) => [one.code, { id: one.id, active: one.active }])),
      shifts: new Map(shifts.map((one) => [one.name, { id: one.id, active: one.active }])),
      approvedKiosks: new Set(kiosks.map((one) => one.id)),
    };
  }

  private async heldFor(codes: string[]): Promise<Map<string, Held>> {
    const held = new Map<string, Held>();
    for (const slice of chunks(codes)) {
      const people = await this.db.employee.findMany({ where: { code: { in: slice } }, select: HELD });
      people.forEach((one) => held.set(one.code, heldOf(one)));
    }
    return held;
  }

  private async codesAmong(codes: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    for (const slice of chunks(codes)) {
      const rows = await this.db.employee.findMany({ where: { code: { in: slice } }, select: { code: true } });
      rows.forEach((one) => found.add(one.code));
    }
    return found;
  }

  private async loginEmailsAmong(emails: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    for (const slice of chunks(emails)) {
      const rows = await this.db.user.findMany({ where: { email: { in: slice } }, select: { email: true } });
      rows.forEach((one) => found.add(one.email));
    }
    return found;
  }

  /** Managers are linked once every person in the file exists, so a line may name a manager
   *  that arrives later in the same upload; an empty cell clears the manager.
   */
  private async linkManagers(
    tx: Prisma.TransactionClient,
    rows: ImportRow[],
    codes: string[],
    before: Map<number, number | null>,
  ): Promise<RoleFlip[]> {
    for (let at = 0; at < rows.length; at += kWriteChunk) {
      const slice = rows.slice(at, at + kWriteChunk);
      await tx.$executeRaw`
        UPDATE "Employee" e
           SET "managerId" = boss."id", "updatedAt" = now()
          FROM unnest(${slice.map((row) => row.code as string)}::text[],
                      ${slice.map((row) => row.managerCode ?? null)}::text[])
               AS v("code", "bossCode")
          LEFT JOIN "Employee" boss ON boss."code" = v."bossCode"
         WHERE e."code" = v."code" AND e."managerId" IS DISTINCT FROM boss."id"
      `;
    }
    const after = await managersOf(tx, codes);
    const moved = [...after].filter(([id, boss]) => (before.has(id) ? before.get(id) !== boss : boss !== null));
    if (moved.length === 0) {
      return [];
    }
    const movedIds = moved.map(([id]) => id);
    await this.scope.assertNoManagerCycle(tx, movedIds);
    await repointPending(tx, movedIds);
    return this.users.syncManagerRoles([...moved.map(([id]) => before.get(id)), ...moved.map(([, boss]) => boss)], tx);
  }

  // Pay after the first record moves through /compensation, which writes down from and to (KEHOACH 9.24 rule 4).
  private seedPay(tx: Prisma.TransactionClient, viewer: Viewer, rows: ImportRow[]): Promise<number> {
    return tx.$executeRaw`
      INSERT INTO "CompensationRecord" (
        "id", "employeeId", "effectiveFrom", "baseSalary", "insuranceSalary",
        "reason", "createdById", "createdAt")
      SELECT gen_random_uuid(), e."id", COALESCE(v."from"::date, e."hireDate", CURRENT_DATE),
             v."base"::numeric, v."insurance"::numeric,
             'HIRE'::"PayReason", ${viewer.userId}, now()
        FROM unnest(${rows.map((row) => row.code as string)}::text[],
                    ${rows.map((row) => row.hireDate ?? null)}::text[],
                    ${rows.map((row) => row.baseSalary as string)}::text[],
                    ${rows.map((row) => row.insuranceSalary as string)}::text[])
             AS v("code", "from", "base", "insurance")
        JOIN "Employee" e ON e."code" = v."code"
       WHERE NOT EXISTS (SELECT 1 FROM "CompensationRecord" c WHERE c."employeeId" = e."id")
      ON CONFLICT ("employeeId", "effectiveFrom") DO NOTHING
    `;
  }

  /**
   * The same columns the import reads, filled in, for the people the list filters show.
   * Exporting into a shape the importer will not take back is how a round trip turns into retyping.
   */
  async exportFile(viewer: Viewer, query: EmployeeFilterDto, format: FileFormat): Promise<FileOut> {
    const visible = await this.scope.visibleEmployeeIds(viewer);
    const today = dayAsDate(this.today());
    const rows = await this.db.employee.findMany({
      where: await this.filterWhere(query, visible),
      include: {
        legalEntity: { select: { code: true } },
        department: { select: { code: true } },
        jobTitle: { select: { code: true } },
        manager: { select: { code: true } },
        compensation: { orderBy: { effectiveFrom: "desc" }, take: 1 },
        login: { select: { id: true } },
        _count: { select: { consents: { where: { state: "GRANTED" } } } },
        // Later starts win, the way the roster reads them (KEHOACH 9.17 item 8).
        shifts: {
          where: { validFrom: { lte: today }, OR: [{ validTo: null }, { validTo: { gte: today } }] },
          orderBy: [{ validFrom: "desc" }, { id: "desc" }],
          take: 1,
          include: { shift: { select: { name: true } } },
        },
        enrollments: {
          where: { state: { not: "REVOKED" }, device: { status: "APPROVED" } },
          select: { deviceId: true, state: true },
        },
      },
      orderBy: { code: "asc" },
    });
    const body = rows.map((one) => {
      const [kiosk] = [...one.enrollments].sort(
        (a, b) => (STANDING_ORDER[a.state] ?? 9) - (STANDING_ORDER[b.state] ?? 9) || a.deviceId.localeCompare(b.deviceId),
      );
      const cells: Record<ImportColumn, string> = {
        ...profileOf(one),
        code: one.code,
        legalEntityCode: one.legalEntity?.code ?? "",
        departmentCode: one.department?.code ?? "",
        jobTitleCode: one.jobTitle?.code ?? "",
        managerCode: one.manager?.code ?? "",
        baseSalary: one.compensation[0]?.baseSalary.toFixed(0) ?? "",
        insuranceSalary: one.compensation[0]?.insuranceSalary.toFixed(0) ?? "",
        shiftName: one.shifts[0]?.shift.name ?? "",
        shiftFrom: asDay(one.shifts[0]?.validFrom ?? null),
        kioskId: kiosk?.deviceId ?? "",
        consentPaper: one._count.consents > 0 ? "YES" : "NO",
        openLogin: one.login ? "YES" : "NO",
      };
      return IMPORT_COLUMNS.map((column) => cells[column]);
    });
    if (format === "csv") {
      return { body: Buffer.from(toExcelCsv([...IMPORT_COLUMNS], body), "utf8"), type: CSV_TYPE, name: "employees.csv" };
    }
    const workbook = await writeWorkbook({ header: IMPORT_COLUMNS, rows: body, lists: await this.dropDowns() });
    return { body: workbook, type: XLSX_MIME, name: "employees.xlsx" };
  }

  /** Built at download time from the catalogues in use, so an entry added a moment ago is already in it (KEHOACH 9.20 rule 2). */
  async template(format: FileFormat): Promise<FileOut> {
    if (format === "xlsx") {
      const workbook = await writeWorkbook({ header: IMPORT_COLUMNS, rows: [], lists: await this.dropDowns() });
      return { body: workbook, type: XLSX_MIME, name: "employees-template.xlsx" };
    }
    const [entity] = await this.db.legalEntity.findMany({
      where: { active: true },
      orderBy: { code: "asc" },
      take: 1,
      select: { id: true, code: true },
    });
    const [department, title, shift] = await Promise.all([
      entity
        ? this.db.department.findFirst({
            where: { legalEntityId: entity.id, active: true },
            orderBy: { code: "asc" },
            select: { code: true },
          })
        : null,
      this.db.jobTitle.findFirst({ where: { active: true }, orderBy: { code: "asc" }, select: { code: true } }),
      this.db.shift.findFirst({ where: { active: true }, orderBy: { name: "asc" }, select: { name: true } }),
    ]);
    const sample: Record<ImportColumn, string> = {
      ...TEMPLATE_SAMPLE,
      hireDate: todayIso(),
      legalEntityCode: entity?.code ?? "",
      departmentCode: department?.code ?? "",
      jobTitleCode: title?.code ?? "",
      shiftName: shift?.name ?? "",
      shiftFrom: shift ? todayIso() : "",
    };
    const text = toExcelCsv([...IMPORT_COLUMNS], [IMPORT_COLUMNS.map((column) => sample[column])]);
    return { body: Buffer.from(text, "utf8"), type: CSV_TYPE, name: "employees-template.csv" };
  }

  /** Each catalogue column's drop-down, `code · name`; a department names its entity too when there are several. */
  private async dropDowns(): Promise<Map<ImportColumn, string[]>> {
    const [entities, departments, titles, shifts, kiosks] = await Promise.all([
      this.db.legalEntity.findMany({ where: { active: true }, select: { code: true, name: true }, orderBy: { code: "asc" } }),
      this.db.department.findMany({
        where: { active: true, legalEntity: { active: true } },
        select: { code: true, name: true, legalEntity: { select: { code: true } } },
        orderBy: [{ legalEntity: { code: "asc" } }, { code: "asc" }],
      }),
      this.db.jobTitle.findMany({ where: { active: true }, select: { code: true, name: true }, orderBy: { code: "asc" } }),
      this.db.shift.findMany({
        where: { active: true },
        select: { name: true, startTime: true, endTime: true },
        orderBy: [{ startTime: "asc" }, { name: "asc" }],
      }),
      this.enrollment.assignable(),
    ]);
    const entry = (...parts: (string | null)[]) => parts.filter(Boolean).join(ENTRY_SEPARATOR);
    const several = entities.length > 1;
    return new Map<ImportColumn, string[]>([
      ["legalEntityCode", entities.map((one) => entry(one.code, one.name))],
      ["departmentCode", departments.map((one) => entry(one.code, one.name, several ? one.legalEntity.code : null))],
      ["jobTitleCode", titles.map((one) => entry(one.code, one.name))],
      ["shiftName", shifts.map((one) => entry(one.name, `${one.startTime}–${one.endTime}`))],
      ["kioskId", kiosks.map((one) => entry(one.id, one.name ?? one.location))],
      ["gender", [...GENDERS]],
      ["consentPaper", [...FLAGS]],
      ["openLogin", [...FLAGS]],
    ]);
  }

  private async filterWhere(query: EmployeeFilterDto, visible: number[] | null): Promise<Prisma.EmployeeWhereInput> {
    const branch = query.departmentId ? await departmentSubtree(this.db, query.departmentId) : null;
    return {
      ...ScopeService.narrow("id", visible),
      ...(branch ? { departmentId: { in: branch } } : {}),
      ...(query.active === undefined ? {} : { active: query.active }),
      ...(query.ending ? { active: true, contracts: { some: this.endingWindow(query) } } : {}),
      ...(query.search
        ? {
            OR: [
              { code: { contains: query.search, mode: "insensitive" } },
              { fullName: { contains: query.search, mode: "insensitive" } },
            ],
          }
        : {}),
    };
  }

  /** Everyone the list shows under this filter, by code, for a bulk run (KEHOACH 9.20).
   *  @ctx task | reads only | throws SELECTION_TOO_LARGE above `cap`, rather than acting on the first `cap`
   */
  async matchingIds(viewer: Viewer, query: EmployeeFilterDto, cap: number): Promise<number[]> {
    const visible = await this.scope.visibleEmployeeIds(viewer);
    const rows = await this.db.employee.findMany({
      where: await this.filterWhere(query, visible),
      select: { id: true },
      orderBy: [{ code: "asc" }, { id: "asc" }],
      take: cap + 1,
    });
    if (rows.length > cap) {
      throw new BadRequestException("SELECTION_TOO_LARGE");
    }
    return rows.map((row) => row.id);
  }

  /** How many people still work here and how many left, under the search and department filters. */
  async counts(query: EmployeeFilterDto, viewer: Viewer): Promise<{ active: number; left: number }> {
    const visible = await this.scope.visibleEmployeeIds(viewer);
    const where = await this.filterWhere({ ...query, active: undefined }, visible);
    const [active, left] = await Promise.all([
      this.db.employee.count({ where: { AND: [where, { active: true }] } }),
      this.db.employee.count({ where: { AND: [where, { active: false }] } }),
    ]);
    return { active, left };
  }

  // A lapsed contract still marked ACTIVE counts: it is the most urgent one (KEHOACH 9.18 item 1).
  private endingWindow(query: EmployeeFilterDto): Prisma.EmploymentContractWhereInput {
    const today = dayAsDate(localDay(new Date(), this.config.get("APP_TIMEZONE", { infer: true })));
    const horizon = new Date(today.getTime() + (query.within ?? ENDING_WINDOW_DAYS) * kMsPerDay);
    return query.ending === "contract"
      ? { state: "ACTIVE", endDate: { lte: horizon } }
      : { state: "ACTIVE", probationEnd: { gte: today, lte: horizon } };
  }

  /** Soonest ending first. The window holds few people, so they are ordered here and paged by (day, id). */
  private async endingPage(
    query: ListEmployeesDto,
    viewer: Viewer,
    visible: number[] | null,
    where: Prisma.EmployeeWhereInput,
  ): Promise<Page<Employee & { endsOn: string }>> {
    const window = this.endingWindow(query);
    const held = await this.db.employee.findMany({
      where,
      select: { id: true, contracts: { where: window, select: { endDate: true, probationEnd: true } } },
    });
    const ends = held
      .map((one) => ({
        id: one.id,
        endsOn: earliestDay(one.contracts.map((deal) => (query.ending === "contract" ? deal.endDate : deal.probationEnd))),
      }))
      .sort((a, b) => a.endsOn.localeCompare(b.endsOn) || a.id - b.id);
    const from = query.cursor ? decodeCursor(query.cursor) : null;
    const start = from
      ? ends.findIndex((one) => one.endsOn > from.sortValue || (one.endsOn === from.sortValue && one.id > Number(from.id)))
      : query.skip;
    const slice = start < 0 ? [] : ends.slice(start, start + query.take);
    const rows = await this.db.employee.findMany({
      where: { id: { in: slice.map((one) => one.id) } },
      include: EMPLOYEE_VIEW,
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    const page = slice.flatMap((one) => {
      const row = byId.get(one.id);
      return row ? [{ ...asSeenBy(row, viewer, visible), endsOn: one.endsOn }] : [];
    });
    return { rows: page, ...countedTo(ends.length), next: nextCursor(page, query.take, (row) => row.endsOn) };
  }

  async list(query: ListEmployeesDto, viewer: Viewer): Promise<Page<Employee>> {
    const visible = await this.scope.visibleEmployeeIds(viewer);
    const where = await this.filterWhere(query, visible);
    if (query.ending) {
      return this.endingPage(query, viewer, visible, where);
    }
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
    const placed = await this.placement(body, null);
    let written: { made: Employee; flips: RoleFlip[] };
    try {
      written = await this.db.$transaction(async (tx) => {
        const made = await tx.employee.create({ data: { ...dated(body), ...placed } });
        return { made, flips: await this.users.syncManagerRoles([made.managerId], tx) };
      });
    } catch (error) {
      if (isCode(error, UNIQUE_VIOLATION)) {
        throw new ConflictException("EMPLOYEE_CODE_TAKEN");
      }
      throw error;
    }
    const { made, flips } = written;
    if (made.managerId !== null) {
      await this.scope.forgetScopes();
    }
    await this.users.settleRoleFlips(viewer.userId, flips);
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.EMPLOYEE_CREATE,
      subject: AUDIT_SUBJECTS.EMPLOYEE,
      subjectId: String(made.id),
      meta: { code: made.code },
    });
    return made;
  }

  /** Check that the entity, department, job title and manager asked for exist and fit together.
   *  A department decides the entity when none is named; a new hire with neither gets the only entity.
   */
  private async placement(
    asked: {
      legalEntityId?: string;
      departmentId?: string | null;
      jobTitleId?: string | null;
      managerId?: number | null;
    },
    held: HeldPlace | null,
  ): Promise<{ legalEntityId?: string }> {
    const departmentId = asked.departmentId === undefined ? (held?.departmentId ?? null) : asked.departmentId;
    const [entity, department, title, manager, entities] = await Promise.all([
      asked.legalEntityId
        ? this.db.legalEntity.findUnique({ where: { id: asked.legalEntityId }, select: { active: true } })
        : null,
      departmentId
        ? this.db.department.findUnique({ where: { id: departmentId }, select: { active: true, legalEntityId: true } })
        : null,
      asked.jobTitleId
        ? this.db.jobTitle.findUnique({ where: { id: asked.jobTitleId }, select: { active: true } })
        : null,
      asked.managerId
        ? this.db.employee.findUnique({ where: { id: asked.managerId }, select: { active: true, leaveDate: true } })
        : null,
      held === null ? this.db.legalEntity.findMany({ where: { active: true }, select: { id: true }, take: 2 }) : [],
    ]);
    if (asked.legalEntityId && !entity?.active) {
      throw new NotFoundException("LEGAL_ENTITY_NOT_FOUND");
    }
    if (asked.jobTitleId && !title?.active) {
      throw new NotFoundException("JOB_TITLE_NOT_FOUND");
    }
    if (asked.managerId && !manager) {
      throw new NotFoundException("MANAGER_NOT_FOUND");
    }
    if (manager && (!manager.active || manager.leaveDate !== null)) {
      throw new ConflictException("MANAGER_HAS_LEFT");
    }
    if (departmentId && (!department || (asked.departmentId && !department.active))) {
      throw new NotFoundException("DEPARTMENT_NOT_FOUND");
    }
    const entityId = asked.legalEntityId ?? held?.legalEntityId ?? null;
    const moves = held === null || asked.departmentId !== undefined || asked.legalEntityId !== undefined;
    if (moves && department && entityId && department.legalEntityId !== entityId) {
      throw new BadRequestException("DEPARTMENT_OTHER_ENTITY");
    }
    if (moves && department && !entityId) {
      return { legalEntityId: department.legalEntityId };
    }
    const only = entities.length === 1 ? entities[0] : undefined;
    return !entityId && only ? { legalEntityId: only.id } : {};
  }

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

  /** Today on the business calendar, which is what a last day is compared with (KEHOACH 9.8). */
  today(): string {
    return localDay(new Date(), this.config.get("APP_TIMEZONE", { infer: true }));
  }

  /**
   * Record the last day and list what they still hold. A day already here closes the
   * record in this call; a later one only schedules it (KEHOACH 9.14).
   */
  async offboard(viewer: Viewer, id: number, body: OffboardDto): Promise<Offboarding> {
    const person = await this.get(id, viewer);
    const lastDay = body.leaveDate.slice(0, 10);
    const written = await this.db.employee.updateMany({
      where: { id, active: true, leaveDate: null },
      data: { leaveDate: dayAsDate(lastDay) },
    });
    if (written.count === 0) {
      await this.refuseLeaving(id, true);
    }
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.EMPLOYEE_OFFBOARD,
      subject: AUDIT_SUBJECTS.EMPLOYEE,
      subjectId: String(id),
      meta: { code: person.code, leaveDate: lastDay, reason: body.reason },
    });
    return this.settleLeaving(id, person.code, lastDay, viewer.userId);
  }

  /** Move a scheduled last day; a day already here closes the record as recording it would. */
  async moveLeaving(viewer: Viewer, id: number, body: MoveLeavingDto): Promise<Offboarding> {
    const person = await this.get(id, viewer);
    const lastDay = body.leaveDate.slice(0, 10);
    const moved = await this.db.employee.updateMany({
      where: { id, active: true, leaveDate: { not: null } },
      data: { leaveDate: dayAsDate(lastDay) },
    });
    if (moved.count === 0) {
      await this.refuseLeaving(id, false);
    }
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.EMPLOYEE_LEAVING_MOVE,
      subject: AUDIT_SUBJECTS.EMPLOYEE,
      subjectId: String(id),
      meta: { code: person.code, from: asDay(person.leaveDate), to: lastDay },
    });
    return this.settleLeaving(id, person.code, lastDay, viewer.userId);
  }

  /** Call off a leaving that has not happened yet; the person carries on working. */
  async cancelLeaving(viewer: Viewer, id: number): Promise<Employee> {
    const person = await this.get(id, viewer);
    const cancelled = await this.db.employee.updateMany({
      where: { id, active: true, leaveDate: { not: null } },
      data: { leaveDate: null },
    });
    if (cancelled.count === 0) {
      await this.refuseLeaving(id, false);
    }
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.EMPLOYEE_LEAVING_CANCEL,
      subject: AUDIT_SUBJECTS.EMPLOYEE,
      subjectId: String(id),
      meta: { code: person.code, leaveDate: asDay(person.leaveDate) },
    });
    return this.get(id, viewer);
  }

  /** Close every open record whose last day is behind `today`, and answer the ones this pass closed. */
  async closeDue(today: string): Promise<number[]> {
    const through = dayBefore(today);
    const due = await this.db.employee.findMany({
      where: { active: true, leaveDate: { lte: dayAsDate(through) } },
      select: { id: true },
      orderBy: { id: "asc" },
    });
    const closed: number[] = [];
    for (const one of due) {
      if (await this.close(one.id, through)) {
        closed.push(one.id);
      }
    }
    return closed;
  }

  // Read after a guarded write missed, so the code names what actually stood in the way.
  private async refuseLeaving(id: number, recording: boolean): Promise<never> {
    const held = await this.db.employee.findUnique({ where: { id }, select: { active: true, leaveDate: true } });
    if (!held?.active) {
      throw new ConflictException(recording ? "EMPLOYEE_HAS_LEFT" : "LEAVING_CLOSED");
    }
    throw new ConflictException(held.leaveDate === null ? "LEAVING_NOT_SCHEDULED" : "LEAVING_SCHEDULED");
  }

  /**
   * The one way a record closes, for the desk's click and the nightly job alike (KEHOACH 9.14).
   * Only an open record whose last day is `through` or earlier closes; false when none did.
   */
  private async close(id: number, through: string, actorId?: string): Promise<boolean> {
    const shut = await this.db.$transaction(async (tx) => {
      const flipped = await tx.employee.updateMany({
        where: { id, active: true, leaveDate: { lte: dayAsDate(through) } },
        data: { active: false },
      });
      if (flipped.count === 0) {
        return null;
      }
      const person = await tx.employee.findUniqueOrThrow({
        where: { id },
        select: {
          code: true,
          managerId: true,
          leaveDate: true,
          _count: { select: { templates: true, enrollments: { where: { state: { not: "REVOKED" } } } } },
        },
      });
      await tx.user.updateMany({ where: { employeeId: id }, data: { active: false } });
      await tx.session.updateMany({
        where: { user: { employeeId: id }, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      return { person, flips: await this.users.syncManagerRoles([person.managerId], tx) };
    });
    if (!shut) {
      return false;
    }
    const logins = await this.db.user.findMany({ where: { employeeId: id }, select: { id: true } });
    await this.auth.cutAccess(logins.map((one) => one.id));
    await this.scope.forgetScopes();
    await this.users.settleRoleFlips(actorId, shut.flips);
    const held = shut.person._count;
    if (held.templates > 0 || held.enrollments > 0) {
      await this.enrollment.erase(id, actorId, "left");
    }
    await this.audit.record({
      actorId,
      action: AUDIT_ACTIONS.EMPLOYEE_DEACTIVATE,
      subject: AUDIT_SUBJECTS.EMPLOYEE,
      subjectId: String(id),
      meta: { code: shut.person.code, leaveDate: asDay(shut.person.leaveDate) },
    });
    return true;
  }

  private async settleLeaving(id: number, code: string, lastDay: string, actorId: string): Promise<Offboarding> {
    const today = this.today();
    const closed = lastDay <= today && (await this.close(id, today, actorId));
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
      code,
      leaveDate: lastDay,
      closed,
      assetsOutstanding: assets,
      requestsPending: requests,
      advancesOutstanding: advances,
    };
  }

  /** Correct a record. A new manager takes the pending requests with them and settles who is
   *  MANAGER, all in the same transaction as the move (KEHOACH 9.4).
   */
  async update(id: number, body: UpdateEmployeeDto, viewer: Viewer): Promise<Employee> {
    const held = await this.get(id, viewer);
    const placed = await this.placement(body, held);
    let written: { saved: Employee; flips: RoleFlip[] };
    try {
      written = await this.db.$transaction(async (tx) => {
        const before = await tx.employee.findUniqueOrThrow({ where: { id }, select: { managerId: true } });
        const saved = await tx.employee.update({ where: { id }, data: { ...dated(body), ...placed } });
        if (saved.managerId === before.managerId) {
          return { saved, flips: [] };
        }
        await this.scope.assertNoManagerCycle(tx, [id]);
        await repointPending(tx, [id]);
        return { saved, flips: await this.users.syncManagerRoles([before.managerId, saved.managerId], tx) };
      });
    } catch (error) {
      if (isCode(error, UNIQUE_VIOLATION)) {
        throw new ConflictException("EMPLOYEE_CODE_TAKEN");
      }
      throw error;
    }
    if (body.managerId !== undefined) {
      await this.scope.forgetScopes();
    }
    await this.users.settleRoleFlips(viewer.userId, written.flips);
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
    return written.saved;
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
