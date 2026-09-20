import { Injectable, Logger } from "@nestjs/common";
import type { AuditLog, Prisma } from "@prisma/client";

import { COUNT_CEILING, countedTo } from "../../common/dto/cursor.dto.js";
import type { Page } from "../../common/dto/pagination.dto.js";
import { PrismaService } from "../../database/prisma.service.js";
import type { AuditAction, AuditSubject } from "./audit-actions.js";
import type { AuditQueryDto } from "./dto/audit-query.dto.js";

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

  constructor(private readonly db: PrismaService) {}

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

  /** Read it the way somebody traces back: one thing, or one person's doing. */
  async list(query: AuditQueryDto): Promise<Page<AuditLog>> {
    const where: Prisma.AuditLogWhereInput = {
      ...(query.subjectType ? { subjectType: query.subjectType } : {}),
      ...(query.subjectId ? { subjectId: query.subjectId } : {}),
      ...(query.actorId ? { actorId: query.actorId } : {}),
      ...(query.action ? { action: query.action } : {}),
    };
    const [rows, found] = await Promise.all([
      this.db.auditLog.findMany({
        where,
        skip: query.skip,
        take: query.take,
        orderBy: { ts: "desc" },
      }),
      this.db.auditLog.count({ where, take: COUNT_CEILING + 1 }),
    ]);
    return { rows, ...countedTo(found) };
  }
}
