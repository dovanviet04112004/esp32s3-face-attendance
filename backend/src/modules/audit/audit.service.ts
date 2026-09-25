import { BadRequestException, Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { AuditLog, Prisma } from "@prisma/client";

import { COUNT_CEILING, countedTo, decodeCursor, nextCursor } from "../../common/dto/cursor.dto.js";
import type { Page } from "../../common/dto/pagination.dto.js";
import type { Env } from "../../config/env.schema.js";
import { PrismaService } from "../../database/prisma.service.js";
import { dayWindow } from "../timesheet/local-day.js";
import { AUDIT_SUBJECTS, type AuditAction, type AuditSubject } from "./audit-actions.js";
import type { AuditQueryDto } from "./dto/audit-query.dto.js";

/** A log line reads as a person, not as the key their account happens to hold. */
export type AuditRow = AuditLog & {
  actor: { email: string; employee: { code: string; fullName: string } | null } | null;
  subjectName: string | null;
};

export interface AuditEntry {
  actorId?: string;
  action: AuditAction;
  subject: AuditSubject;
  subjectId: string;
  meta?: Prisma.InputJsonValue;
}

@Injectable()
export class AuditService {
  private readonly log = new Logger(AuditService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Record an action. A failure here never fails the request that caused it:
   *  losing the note is better than undoing the work it describes.
   */
  async record(entry: AuditEntry): Promise<void> {
    const { subject, ...rest } = entry;
    try {
      await this.db.auditLog.create({ data: { ...rest, subjectType: subject } });
    } catch {
      this.log.error(`audit for ${entry.action} ${entry.subjectId} went unwritten`);
    }
  }

  /** One line per entry in one statement, for a run over many people; it fails as softly as record(). */
  async recordMany(entries: readonly AuditEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    try {
      await this.db.auditLog.createMany({
        data: entries.map(({ subject, ...rest }) => ({ ...rest, subjectType: subject })),
      });
    } catch {
      this.log.error(`audit for ${entries.length} ${entries[0]?.action} line(s) went unwritten`);
    }
  }

  /** Read it the way somebody traces back: one thing, or one person's doing, over some days. */
  async list(query: AuditQueryDto): Promise<Page<AuditRow>> {
    const zone = this.config.get("APP_TIMEZONE", { infer: true });
    const where: Prisma.AuditLogWhereInput = {
      ...(query.subjectType ? { subjectType: query.subjectType } : {}),
      ...(query.subjectId ? { subjectId: query.subjectId } : {}),
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(query.from || query.to
        ? {
            ts: {
              ...(query.from ? { gte: dayWindow(query.from, zone).from } : {}),
              ...(query.to ? { lt: dayWindow(query.to, zone).to } : {}),
            },
          }
        : {}),
    };
    const from = query.cursor ? decodeCursor(query.cursor) : null;
    if (from && (!/^\d+$/.test(from.id) || Number.isNaN(Date.parse(from.sortValue)))) {
      throw new BadRequestException("CURSOR_INVALID");
    }
    const resumed: Prisma.AuditLogWhereInput = from
      ? {
          AND: [
            where,
            {
              OR: [
                { ts: { lt: new Date(from.sortValue) } },
                { ts: new Date(from.sortValue), id: { lt: BigInt(from.id) } },
              ],
            },
          ],
        }
      : where;
    const [rows, found] = await Promise.all([
      this.db.auditLog.findMany({
        where: resumed,
        skip: from ? 0 : query.skip,
        take: query.take,
        orderBy: [{ ts: "desc" }, { id: "desc" }],
        include: {
          actor: { select: { email: true, employee: { select: { code: true, fullName: true } } } },
        },
      }),
      this.db.auditLog.count({ where, take: COUNT_CEILING + 1 }),
    ]);
    const names = await this.subjectNames(rows);
    return {
      rows: rows.map((row) => ({ ...row, subjectName: names.get(`${row.subjectType}/${row.subjectId}`) ?? null })),
      ...countedTo(found),
      next: nextCursor(rows, query.take, (row) => row.ts),
    };
  }

  // One query per kind for the page, so a line names the person it is about.
  private async subjectNames(rows: AuditLog[]): Promise<Map<string, string>> {
    const idsOf = (kind: string): string[] => [
      ...new Set(rows.filter((row) => row.subjectType === kind).map((row) => row.subjectId)),
    ];
    const employeeIds = idsOf(AUDIT_SUBJECTS.EMPLOYEE)
      .map(Number)
      .filter((id) => Number.isInteger(id));
    const userIds = idsOf(AUDIT_SUBJECTS.USER);
    const [people, accounts] = await Promise.all([
      employeeIds.length
        ? this.db.employee.findMany({ where: { id: { in: employeeIds } }, select: { id: true, code: true, fullName: true } })
        : [],
      userIds.length ? this.db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, email: true } }) : [],
    ]);
    return new Map([
      ...people.map((one) => [`${AUDIT_SUBJECTS.EMPLOYEE}/${one.id}`, `${one.code} · ${one.fullName}`] as const),
      ...accounts.map((one) => [`${AUDIT_SUBJECTS.USER}/${one.id}`, one.email] as const),
    ]);
  }
}
