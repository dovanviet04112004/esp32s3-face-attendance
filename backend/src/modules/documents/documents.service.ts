import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { Document, DocumentVersion, PersonnelFileType } from "@prisma/client";
import { Prisma } from "@prisma/client";

import {
  COUNT_CEILING,
  countedTo,
  decodeCursor,
  encodeCursor,
} from "../../common/dto/cursor.dto.js";
import type { Page } from "../../common/dto/pagination.dto.js";
import { ScopeService } from "../../common/scope/scope.service.js";
import type { Viewer } from "../../common/scope/viewer.js";
import { PrismaService } from "../../database/prisma.service.js";
import { AUDIT_ACTIONS, AUDIT_SUBJECTS } from "../audit/audit-actions.js";
import { AuditService } from "../audit/audit.service.js";
import type {
  CreateDocumentDto,
  CreateFileTypeDto,
  ListGapsDto,
  ListReadersDto,
  PublishVersionDto,
  ReceiveFileDto,
} from "./dto/documents.dto.js";

const UNIQUE_VIOLATION = "P2002";
const kMonthsPerYear = 12;

export interface ToRead {
  documentId: string;
  code: string;
  title: string;
  versionId: string;
  version: number;
  body: string;
  summary: string | null;
  publishedAt: Date;
  ackAt: Date | null;
}

export interface UnreadCount {
  total: number;
}

export interface Gap {
  employeeId: number;
  code: string;
  fullName: string;
  missing: { typeId: string; code: string; name: string }[];
  expired: { typeId: string; code: string; name: string; expiresAt: string }[];
}

export interface ReaderRow {
  employeeId: number;
  code: string;
  fullName: string;
  ackAt: Date | null;
}

function isCode(error: unknown, code: string): boolean {
  return (error as { code?: string }).code === code;
}

@Injectable()
export class DocumentsService {
  constructor(
    private readonly db: PrismaService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
  ) {}

  list(): Promise<Document[]> {
    return this.db.document.findMany({
      where: { active: true },
      orderBy: { code: "asc" },
      include: { versions: { orderBy: { version: "desc" }, take: 1 } },
    });
  }

  async create(viewer: Viewer, body: CreateDocumentDto): Promise<Document> {
    try {
      const made = await this.db.document.create({
        data: {
          code: body.code,
          title: body.title,
          kind: body.kind ?? "POLICY",
          departmentId: body.departmentId ?? null,
          jobTitleId: body.jobTitleId ?? null,
        },
      });
      await this.audit.record({
        actorId: viewer.userId,
        action: AUDIT_ACTIONS.DOCUMENT_CREATE,
        subject: AUDIT_SUBJECTS.DOCUMENT,
        subjectId: made.id,
        meta: { code: made.code },
      });
      return made;
    } catch (error) {
      if (isCode(error, UNIQUE_VIOLATION)) {
        throw new ConflictException(`document code ${body.code} is taken`);
      }
      throw error;
    }
  }

  /**
   * Publish the next wording. The number comes from counting what is already
   * there, inside the transaction that writes the row (KEHOACH 9.16 item 9).
   */
  async publish(
    viewer: Viewer,
    documentId: string,
    body: PublishVersionDto,
  ): Promise<DocumentVersion> {
    const held = await this.db.document.findUnique({ where: { id: documentId } });
    if (!held) {
      throw new NotFoundException("DOCUMENT_NOT_FOUND");
    }
    const made = await this.db.$transaction(async (tx) => {
      const latest = await tx.documentVersion.findFirst({
        where: { documentId },
        orderBy: { version: "desc" },
        select: { version: true },
      });
      return tx.documentVersion.create({
        data: {
          documentId,
          version: (latest?.version ?? 0) + 1,
          body: body.body,
          summary: body.summary ?? null,
          publishedById: viewer.userId,
        },
      });
    });
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.DOCUMENT_PUBLISH,
      subject: AUDIT_SUBJECTS.DOCUMENT,
      subjectId: documentId,
      meta: { code: held.code, version: made.version },
    });
    return made;
  }

  /**
   * The newest version of everything aimed at this person, with their own
   * acknowledgement beside it. A blank target matches everybody.
   */
  async toRead(employeeId: number): Promise<ToRead[]> {
    return this.db.$queryRaw<ToRead[]>`
      SELECT d."id" AS "documentId", d."code", d."title",
             v."id" AS "versionId", v."version", v."body", v."summary", v."publishedAt",
             a."ackAt"
        FROM "Document" d
        JOIN "Employee" e ON e."id" = ${employeeId}
        JOIN LATERAL (
          SELECT * FROM "DocumentVersion" x
           WHERE x."documentId" = d."id"
           ORDER BY x."version" DESC LIMIT 1
        ) v ON true
        LEFT JOIN "DocumentAck" a
               ON a."versionId" = v."id" AND a."employeeId" = ${employeeId}
       WHERE d."active" = true
         AND (d."departmentId" IS NULL OR d."departmentId" = e."departmentId")
         AND (d."jobTitleId" IS NULL OR d."jobTitleId" = e."jobTitleId")
       ORDER BY a."ackAt" NULLS FIRST, v."publishedAt" DESC
    `;
  }

  async unread(employeeId: number): Promise<UnreadCount> {
    const rows = await this.toRead(employeeId);
    return { total: rows.filter((row) => row.ackAt === null).length };
  }

  /** Reading is what the acknowledgement claims, so only the reader may file
   *  one, and only against a version aimed at them.
   */
  async acknowledge(viewer: Viewer, versionId: string): Promise<{ ackAt: Date }> {
    if (viewer.employeeId === null) {
      throw new BadRequestException("NO_EMPLOYEE_RECORD");
    }
    const mine = await this.toRead(viewer.employeeId);
    const wanted = mine.find((row) => row.versionId === versionId);
    if (!wanted) {
      throw new NotFoundException("VERSION_NOT_FOUND");
    }
    const saved = await this.db.documentAck.upsert({
      where: { versionId_employeeId: { versionId, employeeId: viewer.employeeId } },
      update: {},
      create: { versionId, employeeId: viewer.employeeId },
    });
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.DOCUMENT_ACK,
      subject: AUDIT_SUBJECTS.DOCUMENT,
      subjectId: wanted.documentId,
      meta: { code: wanted.code, version: wanted.version },
    });
    return { ackAt: saved.ackAt };
  }

  /** Who a version reaches, and which of them have signed for it. */
  /** Whoever has not signed comes first, because that is the list a desk acts
   *  on, and the cursor carries that flag beside the code (KEHOACH 9.9 rule 3).
   */
  async readers(
    documentId: string,
    query: ListReadersDto,
    version?: number,
  ): Promise<Page<ReaderRow>> {
    const wanted = await this.db.documentVersion.findFirst({
      where: { documentId, ...(version === undefined ? {} : { version }) },
      orderBy: { version: "desc" },
      include: { document: true },
    });
    if (!wanted) {
      throw new NotFoundException("VERSION_NOT_FOUND");
    }
    const target = wanted.document;
    const after = query.cursor ? decodeCursor(query.cursor) : null;
    const reach = Prisma.sql`
       WHERE e."active" = true
         AND (${target.departmentId}::text IS NULL OR e."departmentId" = ${target.departmentId})
         AND (${target.jobTitleId}::text IS NULL OR e."jobTitleId" = ${target.jobTitleId})`;
    const [rows, counted] = await Promise.all([
      this.db.$queryRaw<ReaderRow[]>`
        SELECT e."id" AS "employeeId", e."code", e."fullName", a."ackAt"
          FROM "Employee" e
          LEFT JOIN "DocumentAck" a
                 ON a."employeeId" = e."id" AND a."versionId" = ${wanted.id}
        ${reach}
          AND (
            ${after?.sortValue ?? null}::text IS NULL
            OR ((CASE WHEN a."ackAt" IS NULL THEN '0' ELSE '1' END) || e."code")
               > ${after?.sortValue ?? null}::text
          )
         ORDER BY (CASE WHEN a."ackAt" IS NULL THEN '0' ELSE '1' END) || e."code"
         LIMIT ${query.take}
      `,
      this.db.$queryRaw<{ found: bigint }[]>`
        SELECT count(*) AS "found" FROM (
          SELECT 1 FROM "Employee" e ${reach} LIMIT ${COUNT_CEILING + 1}
        ) x
      `,
    ]);
    const last = rows[rows.length - 1];
    return {
      ...countedTo(Number(counted[0]?.found ?? 0)),
      rows,
      next:
        rows.length === query.take && last
          ? encodeCursor(`${last.ackAt === null ? "0" : "1"}${last.code}`, last.employeeId)
          : null,
    };
  }

  fileTypes(): Promise<PersonnelFileType[]> {
    return this.db.personnelFileType.findMany({
      where: { active: true },
      orderBy: [{ ordinal: "asc" }, { code: "asc" }],
    });
  }

  async createFileType(viewer: Viewer, body: CreateFileTypeDto): Promise<PersonnelFileType> {
    try {
      const made = await this.db.personnelFileType.create({
        data: {
          code: body.code,
          name: body.name,
          required: body.required ?? true,
          validMonths: body.validMonths ?? null,
          ordinal: body.ordinal ?? 0,
        },
      });
      await this.audit.record({
        actorId: viewer.userId,
        action: AUDIT_ACTIONS.FILE_TYPE_CREATE,
        subject: AUDIT_SUBJECTS.DOCUMENT,
        subjectId: made.id,
        meta: { code: made.code },
      });
      return made;
    } catch (error) {
      if (isCode(error, UNIQUE_VIOLATION)) {
        throw new ConflictException(`file type ${body.code} is taken`);
      }
      throw error;
    }
  }

  /** Record that one piece of paper arrived. The expiry follows from the type,
   *  so nobody has to work out a date that the type already implies.
   */
  async receive(viewer: Viewer, body: ReceiveFileDto): Promise<{ id: string; expiresAt: Date | null }> {
    const kind = await this.db.personnelFileType.findUnique({ where: { id: body.typeId } });
    if (!kind) {
      throw new NotFoundException("FILE_TYPE_NOT_FOUND");
    }
    const receivedAt = new Date(body.receivedAt);
    const expiresAt =
      kind.validMonths === null
        ? null
        : new Date(
            Date.UTC(
              receivedAt.getUTCFullYear() + Math.floor(kind.validMonths / kMonthsPerYear),
              receivedAt.getUTCMonth() + (kind.validMonths % kMonthsPerYear),
              receivedAt.getUTCDate(),
            ),
          );
    const saved = await this.db.personnelFile.upsert({
      where: { employeeId_typeId: { employeeId: body.employeeId, typeId: body.typeId } },
      update: { receivedAt, expiresAt, note: body.note ?? null, receivedById: viewer.userId },
      create: {
        employeeId: body.employeeId,
        typeId: body.typeId,
        receivedAt,
        expiresAt,
        note: body.note ?? null,
        receivedById: viewer.userId,
      },
    });
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.FILE_RECEIVE,
      subject: AUDIT_SUBJECTS.EMPLOYEE,
      subjectId: String(body.employeeId),
      meta: { type: kind.code },
    });
    return { id: saved.id, expiresAt: saved.expiresAt };
  }

  /**
   * Who is short of what. A subtraction rather than a column, so adding a
   * required kind changes the answer without touching a row (KEHOACH 9.16.9).
   */
  /** Paged by the person rather than by the row: a page that ended halfway
   *  through somebody would show them as missing less than they are.
   */
  async gaps(viewer: Viewer, query: ListGapsDto): Promise<Page<Gap>> {
    const visible = await this.scope.visibleEmployeeIds(viewer);
    if (visible !== null && visible.length === 0) {
      return { rows: [], total: 0, next: null };
    }
    const after = query.cursor ? decodeCursor(query.cursor).sortValue : null;
    const rows = await this.db.$queryRaw<
      {
        employeeId: number;
        code: string;
        fullName: string;
        typeId: string;
        typeCode: string;
        typeName: string;
        expiresAt: Date | null;
        filed: boolean;
      }[]
    >`
      SELECT e."id" AS "employeeId", e."code", e."fullName",
             t."id" AS "typeId", t."code" AS "typeCode", t."name" AS "typeName",
             f."expiresAt", (f."id" IS NOT NULL) AS "filed"
        FROM "Employee" e
        CROSS JOIN "PersonnelFileType" t
        LEFT JOIN "PersonnelFile" f ON f."employeeId" = e."id" AND f."typeId" = t."id"
       WHERE e."id" IN (
               SELECT e2."id"
                 FROM "Employee" e2
                 CROSS JOIN "PersonnelFileType" t2
                 LEFT JOIN "PersonnelFile" f2
                        ON f2."employeeId" = e2."id" AND f2."typeId" = t2."id"
                WHERE e2."active" = true AND t2."active" = true AND t2."required" = true
                  AND (f2."id" IS NULL
                       OR (f2."expiresAt" IS NOT NULL AND f2."expiresAt" < CURRENT_DATE))
                  ${visible === null ? Prisma.empty : Prisma.sql`AND e2."id" = ANY(${visible}::int[])`}
                  AND (${query.employeeId ?? null}::int IS NULL OR e2."id" = ${query.employeeId ?? null}::int)
                  AND (${after}::text IS NULL OR e2."code" > ${after}::text)
                GROUP BY e2."id", e2."code"
                ORDER BY e2."code"
                LIMIT ${query.take}
             )
         AND t."active" = true AND t."required" = true
         AND (f."id" IS NULL OR (f."expiresAt" IS NOT NULL AND f."expiresAt" < CURRENT_DATE))
       ORDER BY e."code", t."ordinal", t."code"
    `;
    const byPerson = new Map<number, Gap>();
    for (const row of rows) {
      const held = byPerson.get(row.employeeId) ?? {
        employeeId: row.employeeId,
        code: row.code,
        fullName: row.fullName,
        missing: [],
        expired: [],
      };
      const named = { typeId: row.typeId, code: row.typeCode, name: row.typeName };
      if (row.filed && row.expiresAt !== null) {
        held.expired.push({ ...named, expiresAt: row.expiresAt.toISOString().slice(0, 10) });
      } else {
        held.missing.push(named);
      }
      byPerson.set(row.employeeId, held);
    }
    const people = [...byPerson.values()];
    const last = people[people.length - 1];
    const [counted] = await this.db.$queryRaw<{ found: bigint }[]>`
      SELECT count(*) AS "found" FROM (
        SELECT e."id"
          FROM "Employee" e
          CROSS JOIN "PersonnelFileType" t
          LEFT JOIN "PersonnelFile" f ON f."employeeId" = e."id" AND f."typeId" = t."id"
         WHERE e."active" = true AND t."active" = true AND t."required" = true
           AND (f."id" IS NULL OR (f."expiresAt" IS NOT NULL AND f."expiresAt" < CURRENT_DATE))
           ${visible === null ? Prisma.empty : Prisma.sql`AND e."id" = ANY(${visible}::int[])`}
           AND (${query.employeeId ?? null}::int IS NULL OR e."id" = ${query.employeeId ?? null}::int)
         GROUP BY e."id"
         LIMIT ${COUNT_CEILING + 1}
      ) x
    `;
    return {
      ...countedTo(Number(counted?.found ?? 0)),
      rows: people,
      next: people.length === query.take && last ? encodeCursor(last.code, last.employeeId) : null,
    };
  }
}
