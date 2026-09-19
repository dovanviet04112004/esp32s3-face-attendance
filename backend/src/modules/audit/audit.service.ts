import { Injectable, Logger } from "@nestjs/common";
import type { AuditLog, Prisma } from "@prisma/client";

import type { Page, PaginationDto } from "../../common/dto/pagination.dto.js";
import { PrismaService } from "../../database/prisma.service.js";

export interface AuditEntry {
  actorId?: string;
  action: string;
  target: string;
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
    try {
      await this.db.auditLog.create({ data: entry });
    } catch {
      this.log.error(`audit for ${entry.action} ${entry.target} was not written`);
    }
  }

  async list(query: PaginationDto): Promise<Page<AuditLog>> {
    const [rows, total] = await Promise.all([
      this.db.auditLog.findMany({ skip: query.skip, take: query.take, orderBy: { ts: "desc" } }),
      this.db.auditLog.count(),
    ]);
    return { rows, total };
  }
}
