import { Injectable } from "@nestjs/common";

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
}

const kPerKind = 5;
const kMinLength = 2;

@Injectable()
export class SearchService {
  constructor(
    private readonly db: PrismaService,
    private readonly scope: ScopeService,
  ) {}

  /** One box over four tables, each narrowed by what the viewer may see. */
  async find(viewer: Viewer, term: string): Promise<Hit[]> {
    const needle = term.trim();
    if (needle.length < kMinLength) {
      return [];
    }
    const visible = await this.scope.visibleEmployeeIds(viewer);
    const mine = visible === null ? {} : { employeeId: { in: visible } };
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
        where: { ...mine, reason: { contains: needle, mode: "insensitive" } },
        select: {
          id: true,
          kind: true,
          state: true,
          reason: true,
          employee: { select: { fullName: true } },
        },
        orderBy: { createdAt: "desc" },
        take: kPerKind,
      }),
      this.db.payslip.findMany({
        where: {
          ...mine,
          state: { not: "DRAFT" },
          employee: {
            OR: [
              { fullName: { contains: needle, mode: "insensitive" } },
              { code: { contains: needle, mode: "insensitive" } },
            ],
          },
        },
        select: {
          id: true,
          netPay: true,
          employee: { select: { fullName: true } },
          period: { select: { year: true, month: true } },
        },
        orderBy: { createdAt: "desc" },
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
        title: row.employee?.fullName ?? row.kind,
        detail: row.reason,
        href: "/approvals",
      })),
      ...payslips.map((row) => ({
        kind: "payslip" as const,
        id: row.id,
        title: row.employee.fullName,
        detail: `${String(row.period.month).padStart(2, "0")}/${row.period.year} · ${row.netPay.toFixed(0)}`,
        href: `/me/payslips`,
      })),
    ];
  }
}
