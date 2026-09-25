import { BadRequestException } from "@nestjs/common";
import type { Prisma, Role } from "@prisma/client";

import { decodeCursor } from "../../common/dto/cursor.dto.js";
import { departmentSubtree } from "../../common/scope/department-subtree.js";
import type { Viewer } from "../../common/scope/viewer.js";
import type { PrismaService } from "../../database/prisma.service.js";
import { dayWindow } from "../timesheet/local-day.js";
import type { Order, QueueQueryDto } from "./dto/queue.dto.js";

// Where an unclaimed request and every advance wait: 9.4 gives HR both leave
// and a read on payroll (KEHOACH 9.15).
export const THE_DESK: Role[] = ["ADMIN", "HR"];

/** Who decides each desk queue. The lists, the badge and the notices read this one table. */
export const QUEUE_DESKS: Record<
  "certificates" | "profileChanges" | "disputes" | "dependents" | "advancesToDecide" | "advancesToPay",
  Role[]
> = {
  certificates: ["ADMIN", "HR", "PAYROLL"],
  profileChanges: ["ADMIN", "HR"],
  disputes: ["ADMIN", "PAYROLL"],
  dependents: ["ADMIN", "PAYROLL"],
  advancesToDecide: THE_DESK,
  advancesToPay: ["ADMIN", "PAYROLL"],
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
    parts.push({
      OR: [
        { code: { contains: needle, mode: "insensitive" } },
        { fullName: { contains: needle, mode: "insensitive" } },
      ],
    });
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

/** Rows past the cursor in `(field, id)` order. */
export function resumeAfter(field: string, order: Order, cursor: string | undefined): Loose {
  if (!cursor) {
    return {};
  }
  const key = decodeCursor(cursor);
  const at = new Date(key.sortValue);
  if (Number.isNaN(at.getTime())) {
    throw new BadRequestException("CURSOR_INVALID");
  }
  const past = order === "asc" ? "gt" : "lt";
  return {
    AND: [
      // Looks redundant; it is the bound Postgres turns into an index condition (KEHOACH 9.9 rule 3).
      { [field]: { [order === "asc" ? "gte" : "lte"]: at } },
      { OR: [{ [field]: { [past]: at } }, { [field]: at, id: { [past]: key.id } }] },
    ],
  };
}

export function sortedBy(field: string, order: Order): Loose[] {
  return [{ [field]: order }, { id: order }];
}

/** Whole days a row has waited, counted from the first day (KEHOACH 9.17 item 12). */
export function waitedDays(since: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - since.getTime()) / MS_PER_DAY));
}

/** A desk never sees its own rows waiting in the queue it decides (KEHOACH 9.10). */
export function notOwnWaiting(viewer: Viewer, desks: Role[], waiting: boolean, askedFor?: number): Loose {
  if (!waiting || viewer.employeeId === null || !desks.includes(viewer.role) || askedFor === viewer.employeeId) {
    return {};
  }
  return { employeeId: { not: viewer.employeeId } };
}

/** Naming a person narrows what the viewer may see; it never widens it. */
export function whoseRows(visible: number[] | null, asked: number | undefined): Loose {
  if (asked === undefined) {
    return visible === null ? {} : { employeeId: { in: visible } };
  }
  return { employeeId: visible === null || visible.includes(asked) ? asked : { in: [] } };
}
