import type { Prisma, Role } from "@prisma/client";

import { departmentSubtree } from "../../common/scope/department-subtree.js";
import { namedFilter, type PrismaService } from "../../database/prisma.service.js";
import { dayWindow } from "../timesheet/local-day.js";
import type { Order, QueueQueryDto } from "./dto/queue.dto.js";

// Where an unclaimed request and every advance wait: 9.4 gives HR both leave
// and a read on payroll (KEHOACH 9.15).
export const THE_DESK: Role[] = ["ADMIN", "HR"];

export const REQUEST_LEDGER: Role[] = ["ADMIN", "HR", "MANAGER"];

/** Who decides each desk queue. The lists, the badge and the notices read this one table. */
export const QUEUE_DESKS: Record<
  "certificates" | "profileChanges" | "disputes" | "dependents" | "advancesToDecide" | "advancesToPay" | "punches",
  Role[]
> = {
  certificates: ["ADMIN", "HR", "PAYROLL"],
  profileChanges: ["ADMIN", "HR"],
  disputes: ["ADMIN", "PAYROLL"],
  dependents: ["ADMIN", "PAYROLL"],
  advancesToDecide: THE_DESK,
  advancesToPay: ["ADMIN", "PAYROLL"],
  punches: ["ADMIN", "HR"],
};

export const PERSON_VIEW = {
  select: {
    id: true,
    code: true,
    fullName: true,
    department: { select: { id: true, name: true } },
  },
} satisfies Prisma.EmployeeDefaultArgs;

type Loose = Record<string, unknown>;

const MS_PER_DAY = 86_400_000;

/** The person a row is about, by code or name and by a whole branch of the tree; null narrows nothing. */
export async function personWhere(
  db: PrismaService,
  query: Pick<QueueQueryDto, "search" | "departmentId">,
): Promise<Prisma.EmployeeWhereInput | null> {
  const parts: Prisma.EmployeeWhereInput[] = [];
  const needle = query.search?.trim();
  if (needle) {
    const named = await namedFilter(db, needle);
    parts.push({ id: named });
  }
  if (query.departmentId) {
    parts.push({ departmentId: { in: await departmentSubtree(db, query.departmentId) } });
  }
  return parts.length === 0 ? null : { AND: parts };
}

/** Filed on a local day between `from` and `to`, both included. */
export function filedBetween(field: string, query: Pick<QueueQueryDto, "from" | "to">, zone: string): Loose {
  const bound: Record<string, Date> = {};
  if (query.from) {
    bound.gte = dayWindow(query.from.slice(0, 10), zone).from;
  }
  if (query.to) {
    bound.lt = dayWindow(query.to.slice(0, 10), zone).to;
  }
  return Object.keys(bound).length === 0 ? {} : { [field]: bound };
}

export function sortedBy(field: string, order: Order): Loose[] {
  return [{ [field]: order }, { id: order }];
}

/** Whole days a row has waited, counted from the first day (KEHOACH 9.17 item 12). */
export function waitedDays(since: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - since.getTime()) / MS_PER_DAY));
}
