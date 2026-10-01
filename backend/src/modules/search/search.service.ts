import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Prisma, type CertificateKind, type DocumentKind, type ProfileField, type RequestKind, type Role } from "@prisma/client";

import { ScopeService } from "../../common/scope/scope.service.js";
import type { Viewer } from "../../common/scope/viewer.js";
import type { Env } from "../../config/env.schema.js";
import { codeHas, codeLeads, foldedHas, foldedLeads, PrismaService } from "../../database/prisma.service.js";
import { QUEUE_DESKS } from "../leave/queue-filter.js";
import { localDay } from "../timesheet/local-day.js";
import type { HitKind } from "./dto/search.dto.js";

export interface Hit {
  kind: HitKind;
  id: string;
  title: string;
  detail: string;
  href: string;
  requestKind?: RequestKind;
  certificateKind?: CertificateKind;
  profileField?: ProfileField;
  documentKind?: DocumentKind;
}

export interface Found {
  hits: Hit[];
  more: { kind: HitKind; href: string }[];
}

interface Pile {
  hits: Hit[];
  more: string | null;
}

interface Desk {
  roles: Role[];
  waiting: Prisma.Sql;
}

const kPerKind = 5;
const kMinLength = 2;
const NONE: Pile = { hits: [], more: null };

// The pages each role opens, as frontend/lib/nav.ts lets it (KEHOACH 9.15).
const DIRECTORY: Role[] = ["ADMIN", "HR", "PAYROLL", "MANAGER"];
const LEDGER: Role[] = ["ADMIN", "HR", "MANAGER"];
const PAY_DESK: Role[] = ["ADMIN", "HR", "PAYROLL"];
const PEOPLE_DESK: Role[] = ["ADMIN", "HR"];
const OPERATORS: Role[] = ["ADMIN"];

// Matched, never shown: each kind as the vi and en catalogues label it (KEHOACH 9.20).
const REQUEST_WORDS: Record<RequestKind, string[]> = {
  LEAVE: ["Nghỉ phép", "Leave"],
  OVERTIME: ["Tăng ca", "Overtime"],
  ATTENDANCE_FIX: ["Giải trình công", "Attendance fix"],
  BUSINESS_TRIP: ["Công tác", "Business trip"],
  REMOTE_WORK: ["Làm từ xa", "Remote work"],
};
const LETTER_WORDS: Record<CertificateKind, string[]> = {
  EMPLOYMENT: ["Xác nhận công tác", "Letter of employment"],
  INCOME: ["Xác nhận thu nhập", "Letter of income"],
};
const FIELD_WORDS: Record<ProfileField, string[]> = {
  PERSONAL_EMAIL: ["Email liên lạc", "Contact email"],
  PHONE: ["Số điện thoại", "Phone number"],
  BANK: ["Tài khoản nhận lương", "Account your pay goes to"],
  NATIONAL_ID: ["Số CCCD", "National id"],
  TAX_CODE: ["Mã số thuế", "Tax code"],
  SOCIAL_INSURANCE_NO: ["Số sổ bảo hiểm", "Social insurance number"],
};
const GROUP_WORDS = {
  certificate: ["Giấy xác nhận", "Letters"],
  profileChange: ["Đổi hồ sơ", "Record changes"],
  dispute: ["Khiếu nại lương", "Pay disputes"],
  dependent: ["Người phụ thuộc", "Dependants"],
  advance: ["Tạm ứng lương", "Salary advances"],
} satisfies Partial<Record<HitKind, string[]>>;

const DAY_FIRST = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/;
const YEAR_FIRST_DAY = /^(\d{4})-(\d{1,2})-(\d{1,2})$/;
const MONTH_FIRST = /^(\d{1,2})\/(\d{4})$/;
const YEAR_FIRST_MONTH = /^(\d{4})-(\d{1,2})$/;

const NAME = Prisma.sql`e."fullName"`;
const CODE = Prisma.sql`e."code"`;

function fold(text: string): string {
  const words = text.normalize("NFD").replace(/\p{M}/gu, "").replace(/[đĐ]/g, "d").toLowerCase().split(/\s+/);
  return ` ${words.filter(Boolean).join(" ")} `;
}

/** A label one of whose words opens with the term, or a term that holds a whole label. */
function said(words: readonly string[], term: string): boolean {
  const asked = fold(term);
  return words.some((word) => fold(word).includes(asked.trimEnd()) || asked.includes(fold(word)));
}

function kindsSaid<K extends string>(table: Record<K, string[]>, term: string): K[] {
  return (Object.keys(table) as K[]).filter((kind) => said(table[kind], term));
}

/** 23/09 (this year), 23/09/2026 or 2026-09-23 as a calendar day, or null. */
function dayOf(term: string, thisYear: number): string | null {
  const dayFirst = DAY_FIRST.exec(term);
  const yearFirst = YEAR_FIRST_DAY.exec(term);
  const parts = dayFirst
    ? [Number(dayFirst[3] ?? thisYear), Number(dayFirst[2]), Number(dayFirst[1])]
    : yearFirst
      ? [Number(yearFirst[1]), Number(yearFirst[2]), Number(yearFirst[3])]
      : null;
  if (!parts) {
    return null;
  }
  const [year, month, date] = parts;
  const at = new Date(Date.UTC(year, month - 1, date));
  const real = at.getUTCFullYear() === year && at.getUTCMonth() === month - 1 && at.getUTCDate() === date;
  return real ? at.toISOString().slice(0, 10) : null;
}

/** 08/2026 or 2026-08 as a pay month, or null. */
function monthOf(term: string): { year: number; month: number } | null {
  const monthFirst = MONTH_FIRST.exec(term);
  const yearFirst = YEAR_FIRST_MONTH.exec(term);
  const [year, month] = monthFirst
    ? [Number(monthFirst[2]), Number(monthFirst[1])]
    : yearFirst
      ? [Number(yearFirst[1]), Number(yearFirst[2])]
      : [0, 0];
  return month >= 1 && month <= 12 ? { year, month } : null;
}

function day(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function monthName(at: { year: number; month: number }): string {
  return `${String(at.month).padStart(2, "0")}/${at.year}`;
}

function q(text: string): string {
  return encodeURIComponent(text);
}

function anyOf(parts: (Prisma.Sql | null)[]): Prisma.Sql {
  const kept = parts.filter((part): part is Prisma.Sql => part !== null);
  return kept.length === 0 ? Prisma.sql`FALSE` : Prisma.sql`(${Prisma.join(kept, " OR ")})`;
}

function among(column: Prisma.Sql, ids: number[] | null): Prisma.Sql {
  return ids === null ? Prisma.sql`TRUE` : Prisma.sql`${column} = ANY(${ids}::int[])`;
}

function sender(term: string): { has: Prisma.Sql; leads: Prisma.Sql } {
  return {
    has: anyOf([foldedHas(NAME, term), codeHas(CODE, term)]),
    leads: anyOf([foldedLeads(NAME, term), codeLeads(CODE, term)]),
  };
}

/** The viewer's own rows, and the others waiting in a desk queue the viewer decides (KEHOACH 9.4). */
function ownOrDesk(viewer: Viewer, desks: Desk[]): Prisma.Sql | null {
  const me = viewer.employeeId;
  const parts = [
    me === null ? null : Prisma.sql`x."employeeId" = ${me}`,
    ...desks
      .filter((desk) => desk.roles.includes(viewer.role))
      .map((desk) => (me === null ? desk.waiting : Prisma.sql`(${desk.waiting} AND x."employeeId" <> ${me})`)),
  ];
  return parts.some((part) => part !== null) ? anyOf(parts) : null;
}

/** A desk kind's rows by sender or by its own name, best first; `x` is the table, `e` its sender. */
function deskRows(table: string, newest: string, scope: Prisma.Sql, term: string, named: Prisma.Sql | null): Prisma.Sql {
  const by = sender(term);
  return Prisma.sql`
    SELECT x."id", (CASE WHEN ${anyOf([by.leads, named])} THEN 0 ELSE 1 END) AS "rank"
      FROM ${Prisma.raw(`"${table}"`)} x JOIN "Employee" e ON e."id" = x."employeeId"
     WHERE ${scope} AND ${anyOf([by.has, named])}
     ORDER BY "rank", x.${Prisma.raw(`"${newest}"`)} DESC, x."id" DESC`;
}

/** The inbox tab a desk kind waits in, narrowed the way the term matched. */
function inbox(tab: string, term: string, whole: boolean, kinds: string[]): string {
  const narrowed = whole ? "" : kinds.length === 1 ? `&kind=${kinds[0]}` : `&q=${q(term)}`;
  return `/approvals?tab=${tab}${narrowed}`;
}

function inOrder<T extends { id: string | number }>(ids: (string | number)[], rows: T[]): T[] {
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  return ids.slice(0, kPerKind).flatMap((id) => {
    const row = byId.get(String(id));
    return row ? [row] : [];
  });
}

function seeAll(ids: unknown[], href: string | null): string | null {
  return ids.length > kPerKind ? href : null;
}

@Injectable()
export class SearchService {
  constructor(
    private readonly db: PrismaService,
    private readonly scope: ScopeService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Every kind of KEHOACH 9.20 in one answer, each narrowed the way its own page narrows. */
  async find(viewer: Viewer, typed: string): Promise<Found> {
    const term = typed.trim().normalize("NFC");
    if (term.length < kMinLength) {
      return { hits: [], more: [] };
    }
    const visible = await this.scope.visibleEmployeeIds(viewer);
    const piles: [HitKind, Promise<Pile>][] = [
      ["employee", this.people(viewer, term, visible)],
      ["department", this.departments(viewer, term)],
      ["request", this.requests(viewer, term, visible)],
      ["certificate", this.certificates(viewer, term)],
      ["profileChange", this.profileChanges(viewer, term)],
      ["dispute", this.disputes(viewer, term)],
      ["dependent", this.dependents(viewer, term)],
      ["advance", this.advances(viewer, term)],
      ["payslip", this.payslips(viewer, term)],
      ["payrollPeriod", this.periods(viewer, term)],
      ["kiosk", this.kiosks(viewer, term)],
      ["asset", this.assets(viewer, term)],
      ["document", this.documents(viewer, term)],
    ];
    const done = await Promise.all(piles.map(async ([kind, pile]) => [kind, await pile] as const));
    return {
      hits: done.flatMap(([, pile]) => pile.hits),
      more: done.flatMap(([kind, pile]) => (pile.more ? [{ kind, href: pile.more }] : [])),
    };
  }

  private async ranked<T extends string | number>(rows: Prisma.Sql): Promise<T[]> {
    const found = await this.db.$queryRaw<{ id: T }[]>`${rows} LIMIT ${kPerKind + 1}`;
    return found.map((row) => row.id);
  }

  private thisYear(): number {
    return Number(localDay(new Date(), this.config.get("APP_TIMEZONE", { infer: true })).slice(0, 4));
  }

  private async people(viewer: Viewer, term: string, visible: number[] | null): Promise<Pile> {
    if (visible !== null && visible.length === 0) {
      return NONE;
    }
    const by = sender(term);
    const ids = await this.ranked<number>(Prisma.sql`
      SELECT e."id", (CASE WHEN ${by.leads} THEN 0 ELSE 1 END) AS "rank"
        FROM "Employee" e
       WHERE ${by.has} AND ${among(Prisma.sql`e."id"`, visible)}
       ORDER BY "rank", e."createdAt" DESC, e."id" DESC`);
    const rows = await this.db.employee.findMany({
      where: { id: { in: ids } },
      select: { id: true, code: true, fullName: true, department: { select: { name: true } } },
    });
    const desk = DIRECTORY.includes(viewer.role);
    return {
      hits: inOrder(ids, rows).map((row) => ({
        kind: "employee",
        id: String(row.id),
        title: row.fullName,
        detail: [row.code, row.department?.name].filter(Boolean).join(" · "),
        href: desk ? `/employees/${row.id}` : "/me",
      })),
      more: seeAll(ids, desk ? `/employees?q=${q(term)}&active=` : null),
    };
  }

  private async departments(viewer: Viewer, term: string): Promise<Pile> {
    if (!DIRECTORY.includes(viewer.role)) {
      return NONE;
    }
    const name = Prisma.sql`d."name"`;
    const code = Prisma.sql`d."code"`;
    const ids = await this.ranked<string>(Prisma.sql`
      SELECT d."id", (CASE WHEN ${foldedLeads(name, term)} OR ${codeLeads(code, term)} THEN 0 ELSE 1 END) AS "rank"
        FROM "Department" d
       WHERE d."active" AND (${foldedHas(name, term)} OR ${codeHas(code, term)})
       ORDER BY "rank", d."createdAt" DESC, d."id" DESC`);
    const rows = await this.db.department.findMany({
      where: { id: { in: ids } },
      select: { id: true, code: true, name: true },
    });
    const tree = LEDGER.includes(viewer.role);
    return {
      hits: inOrder(ids, rows).map((row) => ({
        kind: "department",
        id: row.id,
        title: row.name,
        detail: row.code,
        href: tree ? `/org?dept=${row.id}` : `/employees?departmentId=${row.id}`,
      })),
      more: seeAll(ids, tree ? `/org?q=${q(term)}` : null),
    };
  }

  private async requests(viewer: Viewer, term: string, visible: number[] | null): Promise<Pile> {
    const ledger = LEDGER.includes(viewer.role);
    if (!ledger && viewer.employeeId === null) {
      return NONE;
    }
    const scope = ledger ? among(Prisma.sql`r."employeeId"`, visible) : Prisma.sql`r."employeeId" = ${viewer.employeeId}`;
    const kinds = kindsSaid(REQUEST_WORDS, term);
    const date = dayOf(term, this.thisYear());
    const reason = Prisma.sql`r."reason"`;
    const by = sender(term);
    const named = kinds.length > 0 ? Prisma.sql`r."kind" = ANY(${kinds}::"RequestKind"[])` : null;
    const dated = date ? Prisma.sql`(r."fromDate" <= ${date}::date AND r."toDate" >= ${date}::date)` : null;
    const ids = await this.ranked<string>(Prisma.sql`
      SELECT r."id", (CASE WHEN ${anyOf([by.leads, foldedLeads(reason, term), named, dated])} THEN 0 ELSE 1 END) AS "rank"
        FROM "Request" r JOIN "Employee" e ON e."id" = r."employeeId"
       WHERE ${scope} AND ${anyOf([by.has, foldedHas(reason, term), named, dated])}
       ORDER BY "rank", r."createdAt" DESC, r."id" DESC`);
    const rows = await this.db.request.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        kind: true,
        fromDate: true,
        toDate: true,
        employeeId: true,
        employee: { select: { code: true, fullName: true } },
      },
    });
    const ledgerList = date ? `/leave?from=${date}&to=${date}` : kinds.length === 1 ? `/leave?kind=${kinds[0]}` : `/leave?q=${q(term)}`;
    return {
      hits: inOrder(ids, rows).map((row) => ({
        kind: "request",
        id: row.id,
        title: row.employee.fullName,
        detail: `${row.employee.code} · ${row.toDate > row.fromDate ? `${day(row.fromDate)} – ${day(row.toDate)}` : day(row.fromDate)}`,
        href: row.employeeId === viewer.employeeId ? `/me/requests?open=${row.id}` : `/leave/${row.id}`,
        requestKind: row.kind,
      })),
      more: seeAll(ids, ledger ? ledgerList : null),
    };
  }

  private async certificates(viewer: Viewer, term: string): Promise<Pile> {
    const desk = QUEUE_DESKS.certificates;
    const scope = ownOrDesk(viewer, [{ roles: desk, waiting: Prisma.sql`x."state" = 'REQUESTED'` }]);
    if (!scope) {
      return NONE;
    }
    const whole = said(GROUP_WORDS.certificate, term);
    const kinds = kindsSaid(LETTER_WORDS, term);
    const named = whole ? Prisma.sql`TRUE` : kinds.length > 0 ? Prisma.sql`x."kind" = ANY(${kinds}::"CertificateKind"[])` : null;
    const ids = await this.ranked<string>(deskRows("Certificate", "createdAt", scope, term, named));
    const rows = await this.db.certificate.findMany({
      where: { id: { in: ids } },
      select: { id: true, kind: true, createdAt: true, employeeId: true, employee: { select: { code: true, fullName: true } } },
    });
    return {
      hits: inOrder(ids, rows).map((row) => ({
        kind: "certificate",
        id: row.id,
        title: row.employee.fullName,
        detail: `${row.employee.code} · ${day(row.createdAt)}`,
        href:
          row.employeeId === viewer.employeeId
            ? `/me/letters?open=${row.id}`
            : `/approvals?tab=certificates&q=${q(row.employee.code)}`,
        certificateKind: row.kind,
      })),
      more: seeAll(ids, desk.includes(viewer.role) ? inbox("certificates", term, whole, kinds) : null),
    };
  }

  private async profileChanges(viewer: Viewer, term: string): Promise<Pile> {
    const desk = QUEUE_DESKS.profileChanges;
    const scope = ownOrDesk(viewer, [{ roles: desk, waiting: Prisma.sql`x."state" = 'PENDING'` }]);
    if (!scope) {
      return NONE;
    }
    const whole = said(GROUP_WORDS.profileChange, term);
    const fields = kindsSaid(FIELD_WORDS, term);
    const named = whole ? Prisma.sql`TRUE` : fields.length > 0 ? Prisma.sql`x."field" = ANY(${fields}::"ProfileField"[])` : null;
    const ids = await this.ranked<string>(deskRows("ProfileChange", "createdAt", scope, term, named));
    const rows = await this.db.profileChange.findMany({
      where: { id: { in: ids } },
      select: { id: true, field: true, createdAt: true, employeeId: true, employee: { select: { code: true, fullName: true } } },
    });
    return {
      hits: inOrder(ids, rows).map((row) => ({
        kind: "profileChange",
        id: row.id,
        title: row.employee.fullName,
        detail: `${row.employee.code} · ${day(row.createdAt)}`,
        href: row.employeeId === viewer.employeeId ? "/me/profile" : `/approvals?tab=profileChanges&q=${q(row.employee.code)}`,
        profileField: row.field,
      })),
      more: seeAll(ids, desk.includes(viewer.role) ? inbox("profileChanges", term, whole, fields) : null),
    };
  }

  private async disputes(viewer: Viewer, term: string): Promise<Pile> {
    const desk = QUEUE_DESKS.disputes;
    const scope = ownOrDesk(viewer, [{ roles: desk, waiting: Prisma.sql`x."state" = 'OPEN'` }]);
    if (!scope) {
      return NONE;
    }
    const whole = said(GROUP_WORDS.dispute, term);
    const ids = await this.ranked<string>(deskRows("PayslipDispute", "createdAt", scope, term, whole ? Prisma.sql`TRUE` : null));
    const rows = await this.db.payslipDispute.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        payslipId: true,
        employeeId: true,
        employee: { select: { code: true, fullName: true } },
        payslip: { select: { period: { select: { year: true, month: true } } } },
      },
    });
    return {
      hits: inOrder(ids, rows).map((row) => ({
        kind: "dispute",
        id: row.id,
        title: row.employee.fullName,
        detail: `${row.employee.code} · ${monthName(row.payslip.period)}`,
        href:
          row.employeeId === viewer.employeeId
            ? `/me/payslips?slip=${row.payslipId}`
            : `/approvals?tab=disputes&q=${q(row.employee.code)}`,
      })),
      more: seeAll(ids, desk.includes(viewer.role) ? inbox("disputes", term, whole, []) : null),
    };
  }

  private async dependents(viewer: Viewer, term: string): Promise<Pile> {
    const desk = QUEUE_DESKS.dependents;
    const scope = ownOrDesk(viewer, [{ roles: desk, waiting: Prisma.sql`x."state" = 'PENDING'` }]);
    if (!scope) {
      return NONE;
    }
    const whole = said(GROUP_WORDS.dependent, term);
    const ids = await this.ranked<string>(deskRows("Dependent", "createdAt", scope, term, whole ? Prisma.sql`TRUE` : null));
    const rows = await this.db.dependent.findMany({
      where: { id: { in: ids } },
      select: { id: true, fullName: true, employeeId: true, employee: { select: { code: true, fullName: true } } },
    });
    return {
      hits: inOrder(ids, rows).map((row) => ({
        kind: "dependent",
        id: row.id,
        title: row.employee.fullName,
        detail: `${row.employee.code} · ${row.fullName}`,
        href:
          row.employeeId === viewer.employeeId
            ? "/me/profile#dependants"
            : `/approvals?tab=dependents&q=${q(row.employee.code)}`,
      })),
      more: seeAll(ids, desk.includes(viewer.role) ? inbox("dependents", term, whole, []) : null),
    };
  }

  private async advances(viewer: Viewer, term: string): Promise<Pile> {
    const deciders = QUEUE_DESKS.advancesToDecide;
    const payers = QUEUE_DESKS.advancesToPay;
    const scope = ownOrDesk(viewer, [
      { roles: deciders, waiting: Prisma.sql`x."state" = 'PENDING'` },
      { roles: payers, waiting: Prisma.sql`x."state" = 'APPROVED'` },
    ]);
    if (!scope) {
      return NONE;
    }
    const whole = said(GROUP_WORDS.advance, term);
    const ids = await this.ranked<string>(deskRows("SalaryAdvance", "requestedAt", scope, term, whole ? Prisma.sql`TRUE` : null));
    const rows = await this.db.salaryAdvance.findMany({
      where: { id: { in: ids } },
      select: { id: true, state: true, requestedAt: true, employeeId: true, employee: { select: { code: true, fullName: true } } },
    });
    const tab = deciders.includes(viewer.role) ? "advancesToDecide" : payers.includes(viewer.role) ? "advancesToPay" : null;
    return {
      hits: inOrder(ids, rows).map((row) => ({
        kind: "advance",
        id: row.id,
        title: row.employee.fullName,
        detail: `${row.employee.code} · ${day(row.requestedAt)}`,
        href:
          row.employeeId === viewer.employeeId
            ? `/me/requests?tab=advances&advance=${row.id}`
            : `/approvals?tab=${row.state === "PENDING" ? "advancesToDecide" : "advancesToPay"}&q=${q(row.employee.code)}`,
      })),
      more: seeAll(ids, tab ? inbox(tab, term, whole, []) : null),
    };
  }

  private async payslips(viewer: Viewer, term: string): Promise<Pile> {
    const desk = PAY_DESK.includes(viewer.role);
    if (!desk && viewer.employeeId === null) {
      return NONE;
    }
    const scope = desk ? Prisma.sql`TRUE` : Prisma.sql`x."employeeId" = ${viewer.employeeId}`;
    const month = monthOf(term);
    const dated = month ? Prisma.sql`(p."year" = ${month.year} AND p."month" = ${month.month})` : null;
    const by = sender(term);
    // Drafts stay out even for the pay desk (KEHOACH 9.20).
    const ids = await this.ranked<string>(Prisma.sql`
      SELECT x."id", (CASE WHEN ${anyOf([by.leads, dated])} THEN 0 ELSE 1 END) AS "rank"
        FROM "Payslip" x
        JOIN "Employee" e ON e."id" = x."employeeId"
        JOIN "PayrollPeriod" p ON p."id" = x."periodId"
       WHERE x."state" <> 'DRAFT' AND ${scope} AND ${anyOf([by.has, dated])}
       ORDER BY "rank", p."year" DESC, p."month" DESC, x."createdAt" DESC, x."id" DESC`);
    const rows = await this.db.payslip.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        periodId: true,
        employeeId: true,
        employee: { select: { code: true, fullName: true } },
        period: { select: { year: true, month: true } },
      },
    });
    // Only a month has a list page: a period's own, when the month has one period.
    const months =
      desk && month && ids.length > kPerKind ? await this.db.payrollPeriod.findMany({ where: month, select: { id: true }, take: 2 }) : [];
    return {
      hits: inOrder(ids, rows).map((row) => ({
        kind: "payslip",
        id: row.id,
        title: row.employee.fullName,
        detail: `${row.employee.code} · ${monthName(row.period)}`,
        href:
          row.employeeId === viewer.employeeId
            ? `/me/payslips?slip=${row.id}`
            : `/payroll/${row.periodId}?q=${q(row.employee.code)}&open=${row.id}`,
      })),
      more: seeAll(ids, months.length === 1 ? `/payroll/${months[0].id}` : null),
    };
  }

  private async periods(viewer: Viewer, term: string): Promise<Pile> {
    const month = monthOf(term);
    if (!PAY_DESK.includes(viewer.role) || !month) {
      return NONE;
    }
    const rows = await this.db.payrollPeriod.findMany({
      where: month,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: kPerKind,
      select: { id: true, year: true, month: true, legalEntity: { select: { name: true } } },
    });
    return {
      hits: rows.map((row) => ({
        kind: "payrollPeriod",
        id: row.id,
        title: monthName(row),
        detail: row.legalEntity?.name ?? "",
        href: `/payroll/${row.id}`,
      })),
      more: null,
    };
  }

  private async kiosks(viewer: Viewer, term: string): Promise<Pile> {
    if (!OPERATORS.includes(viewer.role)) {
      return NONE;
    }
    const id = Prisma.sql`d."id"`;
    const name = Prisma.sql`d."name"`;
    const place = Prisma.sql`d."location"`;
    const ids = await this.ranked<string>(Prisma.sql`
      SELECT d."id", (CASE WHEN ${anyOf([codeLeads(id, term), foldedLeads(name, term), foldedLeads(place, term)])} THEN 0 ELSE 1 END) AS "rank"
        FROM "Device" d
       WHERE ${anyOf([codeHas(id, term), foldedHas(name, term), foldedHas(place, term), codeHas(Prisma.sql`d."serial"`, term)])}
       ORDER BY "rank", d."createdAt" DESC, d."id" DESC`);
    const rows = await this.db.device.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, location: true },
    });
    return {
      hits: inOrder(ids, rows).map((row) => ({
        kind: "kiosk",
        id: row.id,
        title: row.name ?? row.id,
        detail: [row.id, row.location].filter(Boolean).join(" · "),
        href: `/devices/${row.id}`,
      })),
      more: seeAll(ids, `/devices?q=${q(term)}`),
    };
  }

  private async assets(viewer: Viewer, term: string): Promise<Pile> {
    if (!PEOPLE_DESK.includes(viewer.role)) {
      return NONE;
    }
    const code = Prisma.sql`a."code"`;
    const serial = Prisma.sql`a."serialNo"`;
    const name = Prisma.sql`a."name"`;
    const ids = await this.ranked<string>(Prisma.sql`
      SELECT a."id", (CASE WHEN ${anyOf([codeLeads(code, term), codeLeads(serial, term), foldedLeads(name, term)])} THEN 0 ELSE 1 END) AS "rank"
        FROM "Asset" a
       WHERE ${anyOf([codeHas(code, term), codeHas(serial, term), foldedHas(name, term)])}
       ORDER BY "rank", a."createdAt" DESC, a."id" DESC`);
    const rows = await this.db.asset.findMany({
      where: { id: { in: ids } },
      select: { id: true, code: true, name: true, serialNo: true },
    });
    return {
      hits: inOrder(ids, rows).map((row) => ({
        kind: "asset",
        id: row.id,
        title: row.name,
        detail: [row.code, row.serialNo].filter(Boolean).join(" · "),
        href: `/assets?q=${q(row.code)}&open=${row.id}`,
      })),
      more: seeAll(ids, `/assets?q=${q(term)}`),
    };
  }

  private async documents(viewer: Viewer, term: string): Promise<Pile> {
    const desk = PEOPLE_DESK.includes(viewer.role);
    if (!desk && viewer.employeeId === null) {
      return NONE;
    }
    const me = viewer.employeeId;
    // The reach of DocumentsService.toRead: a blank target matches everybody.
    const reach = desk
      ? Prisma.sql`TRUE`
      : Prisma.sql`d."active" AND EXISTS (SELECT 1 FROM "DocumentVersion" v WHERE v."documentId" = d."id")
          AND (d."departmentId" IS NULL OR d."departmentId" = (SELECT "departmentId" FROM "Employee" WHERE "id" = ${me}))
          AND (d."jobTitleId" IS NULL OR d."jobTitleId" = (SELECT "jobTitleId" FROM "Employee" WHERE "id" = ${me}))`;
    const title = Prisma.sql`d."title"`;
    const code = Prisma.sql`d."code"`;
    const ids = await this.ranked<string>(Prisma.sql`
      SELECT d."id", (CASE WHEN ${foldedLeads(title, term)} OR ${codeLeads(code, term)} THEN 0 ELSE 1 END) AS "rank"
        FROM "Document" d
       WHERE ${reach} AND (${foldedHas(title, term)} OR ${codeHas(code, term)})
       ORDER BY "rank", d."createdAt" DESC, d."id" DESC`);
    const rows = await this.db.document.findMany({
      where: { id: { in: ids } },
      select: { id: true, code: true, title: true, kind: true, active: true },
    });
    return {
      hits: inOrder(ids, rows).map((row) => ({
        kind: "document",
        id: row.id,
        title: row.title,
        detail: row.code,
        href: desk ? `/documents?q=${q(row.code)}&open=${row.id}${row.active ? "" : "&retired=1"}` : `/me/documents?doc=${row.id}`,
        documentKind: row.kind,
      })),
      more: seeAll(ids, desk ? `/documents?q=${q(term)}` : null),
    };
  }
}
