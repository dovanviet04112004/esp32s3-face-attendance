import { Injectable } from "@nestjs/common";
import type { Prisma, RequestKind, Role } from "@prisma/client";

import { ScopeService } from "../../common/scope/scope.service.js";
import type { Viewer } from "../../common/scope/viewer.js";
import { PrismaService } from "../../database/prisma.service.js";

export type HitKind = "employee" | "department" | "request" | "payslip";

export interface Hit {
  kind: HitKind;
  id: string;
  title: string;
  detail: string;
  href: string;
  requestKind?: RequestKind;
}

const kPerKind = 5;
const kMinLength = 2;
// The roles whose nav holds the request ledger and its detail page (KEHOACH 9.15).
const LEDGER_READERS: Role[] = ["ADMIN", "HR", "MANAGER"];

function asDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

@Injectable()
export class SearchService {
  constructor(
    private readonly db: PrismaService,
    private readonly scope: ScopeService,
  ) {}

  /** One box over four tables, each narrowed the way its own list narrows. */
  async find(viewer: Viewer, term: string): Promise<Hit[]> {
    const needle = term.trim();
    if (needle.length < kMinLength) {
      return [];
    }
    const [visible, payable] = await Promise.all([
      this.scope.visibleEmployeeIds(viewer),
      // A manager's tree reaches people, never their pay (KEHOACH 9.4).
      this.scope.deskOrSelfEmployeeIds(viewer),
    ]);
    const mine = visible === null ? {} : { employeeId: { in: visible } };
    const paid = payable === null ? {} : { employeeId: { in: payable } };
    const named: Prisma.EmployeeWhereInput = {
      OR: [
        { fullName: { contains: needle, mode: "insensitive" } },
        { code: { contains: needle, mode: "insensitive" } },
      ],
    };
    const [people, departments, requests, payslips] = await Promise.all([
      this.db.employee.findMany({
        where: {
          ...(visible === null ? {} : { id: { in: visible } }),
          OR: [
            { fullName: { contains: needle, mode: "insensitive" } },
            { code: { contains: needle, mode: "insensitive" } },
          ],
        },
        select: { id: true, code: true, fullName: true, department: { select: { name: true } } },
        take: kPerKind,
      }),
      this.db.department.findMany({
        where: {
          OR: [
            { name: { contains: needle, mode: "insensitive" } },
            { code: { contains: needle, mode: "insensitive" } },
          ],
        },
        select: { id: true, code: true, name: true },
        take: kPerKind,
      }),
      this.db.request.findMany({
        where: {
          ...mine,
          OR: [{ reason: { contains: needle, mode: "insensitive" } }, { employee: named }],
        },
        select: {
          id: true,
          kind: true,
          fromDate: true,
          toDate: true,
          employeeId: true,
          employee: { select: { code: true, fullName: true } },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: kPerKind,
      }),
      this.db.payslip.findMany({
        where: { ...paid, state: { not: "DRAFT" }, employee: named },
        select: {
          id: true,
          periodId: true,
          employeeId: true,
          employee: { select: { code: true, fullName: true } },
          period: { select: { year: true, month: true } },
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: kPerKind,
      }),
    ]);

    return [
      ...people.map((row) => ({
        kind: "employee" as const,
        id: String(row.id),
        title: row.fullName,
        detail: `${row.code}${row.department ? ` · ${row.department.name}` : ""}`,
        href: `/employees/${row.id}`,
      })),
      ...departments.map((row) => ({
        kind: "department" as const,
        id: row.id,
        title: row.name,
        detail: row.code,
        href: "/org",
      })),
      ...requests.map((row) => ({
        kind: "request" as const,
        id: row.id,
        title: row.employee.fullName,
        detail: `${row.employee.code} · ${asDay(row.fromDate)}${row.toDate > row.fromDate ? ` – ${asDay(row.toDate)}` : ""}`,
        href:
          row.employeeId !== viewer.employeeId && LEDGER_READERS.includes(viewer.role)
            ? `/leave/${row.id}`
            : `/me/requests?open=${row.id}`,
        requestKind: row.kind,
      })),
      ...payslips.map((row) => ({
        kind: "payslip" as const,
        id: row.id,
        title: row.employee.fullName,
        detail: `${row.employee.code} · ${String(row.period.month).padStart(2, "0")}/${row.period.year}`,
        href: row.employeeId === viewer.employeeId ? "/me/payslips" : `/payroll/${row.periodId}`,
      })),
    ];
  }
}
