import { ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { Prisma, Shift, ShiftAssignment } from "@prisma/client";

import { COUNT_CEILING, countedTo, decodeCursor, nextCursor } from "../../common/dto/cursor.dto.js";
import type { Page } from "../../common/dto/pagination.dto.js";
import { ScopeService } from "../../common/scope/scope.service.js";
import type { Viewer } from "../../common/scope/viewer.js";
import { PrismaService } from "../../database/prisma.service.js";
import type {
  AssignManyDto,
  AssignShiftDto,
  CreateShiftDto,
  ListAssignmentsDto,
  RosterDto,
  UpdateShiftDto,
} from "./dto/shift.dto.js";

const ROSTERED = {
  employee: {
    select: { id: true, code: true, fullName: true, department: { select: { id: true, name: true } } },
  },
} satisfies Prisma.ShiftAssignmentInclude;

export type RosteredAssignment = Prisma.ShiftAssignmentGetPayload<{ include: typeof ROSTERED }>;

const UNIQUE_VIOLATION = "P2002";
const FOREIGN_KEY_VIOLATION = "P2003";
const SATURDAY = 6;
const SUNDAY = 0;

/** What somebody is doing on one future day, which is not what they did on a
 *  past one: a planned day has no measurement (KEHOACH 9.17 item 8).
 */
export interface PlannedDay {
  date: string;
  shift: { id: string; name: string; startTime: string; endTime: string; graceMinutes: number } | null;
  holiday: string | null;
  weekend: boolean;
  away: string | null;
}

@Injectable()
export class ShiftsService {
  constructor(
    private readonly db: PrismaService,
    private readonly scope: ScopeService,
  ) {}

  /**
   * One person's month ahead. A shift roster nobody but HR can read is a
   * roster that has not been published (KEHOACH 9.17 item 8).
   */
  async roster(viewer: Viewer, query: RosterDto): Promise<PlannedDay[]> {
    const employeeId = await this.whose(viewer, query.employeeId);
    const from = new Date(Date.UTC(query.year, query.month - 1, 1));
    const to = new Date(Date.UTC(query.year, query.month, 1));
    const [assignments, holidays, away] = await Promise.all([
      this.db.shiftAssignment.findMany({
        where: {
          employeeId,
          validFrom: { lt: to },
          OR: [{ validTo: null }, { validTo: { gte: from } }],
        },
        include: { shift: true },
        orderBy: { validFrom: "asc" },
      }),
      this.db.holiday.findMany({ where: { date: { gte: from, lt: to } } }),
      // The same four conditions the day build uses, so a day planned here and
      // the same day once measured cannot disagree (KEHOACH 9.8).
      this.db.request.findMany({
        where: {
          employeeId,
          kind: { in: ["LEAVE", "BUSINESS_TRIP", "REMOTE_WORK"] },
          state: "APPROVED",
          halfDay: false,
          fromDate: { lt: to },
          toDate: { gte: from },
        },
        select: { kind: true, fromDate: true, toDate: true },
      }),
    ]);
    const holidayOn = new Map(holidays.map((one) => [asDay(one.date), one.name]));
    const days: PlannedDay[] = [];
    for (let at = new Date(from); at < to; at.setUTCDate(at.getUTCDate() + 1)) {
      const date = new Date(at);
      // Later assignments win: a roster change is a new row, not an edit.
      const holding = assignments.filter(
        (one) => one.validFrom <= date && (one.validTo === null || one.validTo >= date),
      );
      const current = holding[holding.length - 1];
      days.push({
        date: asDay(date),
        shift: current
          ? {
              id: current.shift.id,
              name: current.shift.name,
              startTime: current.shift.startTime,
              endTime: current.shift.endTime,
              graceMinutes: current.shift.graceMinutes,
            }
          : null,
        holiday: holidayOn.get(asDay(date)) ?? null,
        weekend: [SATURDAY, SUNDAY].includes(date.getUTCDay()),
        away: away.find((one) => one.fromDate <= date && one.toDate >= date)?.kind ?? null,
      });
    }
    return days;
  }

  /** Whose roster a caller may read: their own, or somebody in their scope. */
  private async whose(viewer: Viewer, asked?: number): Promise<number> {
    if (asked === undefined) {
      if (viewer.employeeId === null) {
        throw new ForbiddenException("NO_EMPLOYEE_RECORD");
      }
      return viewer.employeeId;
    }
    const visible = await this.scope.visibleEmployeeIds(viewer);
    if (visible !== null && !visible.includes(asked)) {
      throw new NotFoundException("EMPLOYEE_NOT_FOUND");
    }
    return asked;
  }

  list(): Promise<Shift[]> {
    return this.db.shift.findMany({ orderBy: { startTime: "asc" } });
  }

  async get(id: string): Promise<Shift> {
    const found = await this.db.shift.findUnique({ where: { id } });
    if (!found) {
      throw new NotFoundException("SHIFT_NOT_FOUND");
    }
    return found;
  }

  async create(body: CreateShiftDto): Promise<Shift> {
    try {
      return await this.db.shift.create({ data: body });
    } catch (error) {
      if (isCode(error, UNIQUE_VIOLATION)) {
        throw new ConflictException("SHIFT_NAME_TAKEN");
      }
      throw error;
    }
  }

  async update(id: string, body: UpdateShiftDto): Promise<Shift> {
    await this.get(id);
    return this.db.shift.update({ where: { id }, data: body }).catch((error: unknown) => {
      throw isCode(error, UNIQUE_VIOLATION) ? new ConflictException("SHIFT_NAME_TAKEN") : error;
    });
  }

  async deactivate(id: string): Promise<Shift> {
    await this.get(id);
    return this.db.shift.update({ where: { id }, data: { active: false } });
  }

  /** Newest first, paged on (validFrom, id) so a busy shift still pages (KEHOACH 9.9 rule 3). */
  async assignments(id: string, query: ListAssignmentsDto): Promise<Page<RosteredAssignment>> {
    await this.get(id);
    const needle = query.search?.trim() ? { contains: query.search.trim(), mode: "insensitive" as const } : null;
    const where: Prisma.ShiftAssignmentWhereInput = {
      shiftId: id,
      ...(needle ? { employee: { OR: [{ code: needle }, { fullName: needle }] } } : {}),
    };
    const after = query.cursor ? decodeCursor(query.cursor) : null;
    const resume: Prisma.ShiftAssignmentWhereInput = after
      ? {
          OR: [
            { validFrom: { lt: new Date(after.sortValue) } },
            { validFrom: new Date(after.sortValue), id: { lt: after.id } },
          ],
        }
      : {};
    const [rows, found] = await Promise.all([
      this.db.shiftAssignment.findMany({
        where: { AND: [where, resume] },
        include: ROSTERED,
        orderBy: [{ validFrom: "desc" }, { id: "desc" }],
        take: query.take,
        ...(after ? {} : { skip: query.skip }),
      }),
      this.db.shiftAssignment.count({ where, take: COUNT_CEILING + 1 }),
    ]);
    return { rows, ...countedTo(found), next: nextCursor(rows, query.take, (row) => row.validFrom) };
  }

  /** Many people onto one shift from one date; anybody already there from that date is skipped. */
  async assignMany(id: string, body: AssignManyDto): Promise<{ assigned: number; skipped: number }> {
    await this.get(id);
    const wanted = [...new Set(body.employeeIds)];
    const found = await this.db.employee.count({ where: { id: { in: wanted } } });
    if (found !== wanted.length) {
      throw new NotFoundException("EMPLOYEE_NOT_FOUND");
    }
    const validFrom = new Date(body.validFrom);
    const validTo = body.validTo ? new Date(body.validTo) : null;
    const made = await this.db.shiftAssignment.createMany({
      data: wanted.map((employeeId) => ({ shiftId: id, employeeId, validFrom, validTo })),
      skipDuplicates: true,
    });
    return { assigned: made.count, skipped: wanted.length - made.count };
  }

  async assign(id: string, body: AssignShiftDto): Promise<ShiftAssignment> {
    await this.get(id);
    try {
      return await this.db.shiftAssignment.create({
        data: {
          shiftId: id,
          employeeId: body.employeeId,
          validFrom: new Date(body.validFrom),
          validTo: body.validTo ? new Date(body.validTo) : null,
        },
      });
    } catch (error) {
      if (isCode(error, UNIQUE_VIOLATION)) {
        throw new ConflictException("SHIFT_ALREADY_ASSIGNED");
      }
      if (isCode(error, FOREIGN_KEY_VIOLATION)) {
        throw new NotFoundException("EMPLOYEE_NOT_FOUND");
      }
      throw error;
    }
  }

  async unassign(id: string, assignmentId: string): Promise<void> {
    const found = await this.db.shiftAssignment.findFirst({
      where: { id: assignmentId, shiftId: id },
    });
    if (!found) {
      throw new NotFoundException("ASSIGNMENT_NOT_FOUND");
    }
    await this.db.shiftAssignment.delete({ where: { id: assignmentId } });
  }
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function asDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}
