import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { Certificate, PayslipState, Prisma } from "@prisma/client";

import { COUNT_CEILING, countedTo, nextCursor } from "../../common/dto/cursor.dto.js";
import type { Page } from "../../common/dto/pagination.dto.js";
import { ScopeService } from "../../common/scope/scope.service.js";
import type { Viewer } from "../../common/scope/viewer.js";
import type { Env } from "../../config/env.schema.js";
import { PrismaService } from "../../database/prisma.service.js";
import { AUDIT_ACTIONS, AUDIT_SUBJECTS } from "../audit/audit-actions.js";
import { AuditService } from "../audit/audit.service.js";
import {
  PERSON_VIEW,
  QUEUE_DESKS,
  filedBetween,
  notOwnWaiting,
  personWhere,
  resumeAfter,
  sortedBy,
  waitedDays,
  whoseRows,
} from "../leave/queue-filter.js";
import { NotificationsService } from "../notifications/notifications.service.js";
import { localDay } from "../timesheet/local-day.js";
import { letterFor, type Earnings } from "./certificate-text.js";
import type { AskCertificateDto, DecideCertificateDto, ListCertificatesDto } from "./dto/certificate.dto.js";

const DESK = QUEUE_DESKS.certificates;
const SERIAL_DIGITS = 5;
const DEFAULT_MONTHS = 3;
// Every state a slip reaches once it has gone out; opening it does not unsay the income.
const ISSUED_SLIPS: PayslipState[] = ["ISSUED", "SENT", "VIEWED"];

function asDay(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

type Listed = Prisma.CertificateGetPayload<{ include: { employee: typeof PERSON_VIEW } }>;

export interface CertificateRow extends Listed {
  waitedDays: number;
}

@Injectable()
export class CertificatesService {
  private readonly log = new Logger(CertificatesService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly notices: NotificationsService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Somebody asks for a letter. Anyone with a record may ask for their own. */
  async ask(viewer: Viewer, body: AskCertificateDto): Promise<Certificate> {
    if (viewer.employeeId === null) {
      throw new ForbiddenException("NO_EMPLOYEE_RECORD");
    }
    const made = await this.db.certificate.create({
      data: {
        employeeId: viewer.employeeId,
        kind: body.kind,
        purpose: body.purpose,
        months: body.kind === "INCOME" ? (body.months ?? DEFAULT_MONTHS) : null,
      },
    });
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.CERTIFICATE_ASK,
      subject: AUDIT_SUBJECTS.EMPLOYEE,
      subjectId: String(viewer.employeeId),
      meta: { kind: body.kind, purpose: body.purpose },
    });
    await this.notices.raiseToDesk(DESK, "REQUEST_WAITING", { certificateId: made.id }, {
      employeeIds: [viewer.employeeId],
    });
    return made;
  }

  /** Letters are pay-type data: the desk reads all, everyone else their own (KEHOACH 9.4). */
  async list(viewer: Viewer, query: ListCertificatesDto): Promise<Page<CertificateRow>> {
    const visible = await this.scope.deskOrSelfEmployeeIds(viewer);
    const person = await personWhere(this.db, query);
    const waiting = query.state === "REQUESTED";
    // Every clause names employeeId, so an AND keeps the narrowest rather than letting one replace another.
    const where = {
      AND: [
        whoseRows(visible, query.employeeId),
        notOwnWaiting(viewer, DESK, waiting, query.employeeId),
        query.state ? { state: query.state } : {},
        query.kind ? { kind: query.kind } : {},
        person ? { employee: person } : {},
        filedBetween("createdAt", query, this.config.get("APP_TIMEZONE", { infer: true })),
      ],
    } as Prisma.CertificateWhereInput;
    const order = query.order ?? (waiting ? "asc" : "desc");
    const resumed = query.cursor
      ? { AND: [where, resumeAfter("createdAt", order, query.cursor) as Prisma.CertificateWhereInput] }
      : where;
    const [rows, found] = await Promise.all([
      this.db.certificate.findMany({
        where: resumed,
        skip: query.cursor ? 0 : query.skip,
        take: query.take,
        orderBy: sortedBy("createdAt", order) as Prisma.CertificateOrderByWithRelationInput[],
        include: { employee: PERSON_VIEW },
      }),
      this.db.certificate.count({ where, take: COUNT_CEILING + 1 }),
    ]);
    const now = new Date();
    return {
      rows: rows.map((row) => ({ ...row, waitedDays: waitedDays(row.createdAt, now) })),
      ...countedTo(found),
      next: nextCursor(rows, query.take, (row) => row.createdAt),
    };
  }

  /**
   * Hand one out. The serial comes from the database rather than a count of
   * rows, so two people issuing at once cannot be given the same number
   * (KEHOACH 9.23 rule 2).
   */
  async issue(viewer: Viewer, id: string): Promise<Certificate> {
    const held = await this.decidable(viewer, id);
    const [next] = await this.db.$queryRaw<{ n: bigint }[]>`
      SELECT nextval('certificate_serial_seq') AS n
    `;
    const year = localDay(new Date(), this.config.get("APP_TIMEZONE", { infer: true })).slice(0, 4);
    const serial = `${year}/${String(next.n).padStart(SERIAL_DIGITS, "0")}`;
    // A second issue that read REQUESTED too loses here; its sequence value is left as a gap, never reused.
    const claimed = await this.db.certificate.updateMany({
      where: { id: held.id, state: "REQUESTED" },
      data: { state: "ISSUED", serial, issuedAt: new Date(), issuedById: viewer.userId },
    });
    if (claimed.count !== 1) {
      throw new BadRequestException("CERTIFICATE_ALREADY_DECIDED");
    }
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.CERTIFICATE_ISSUE,
      subject: AUDIT_SUBJECTS.EMPLOYEE,
      subjectId: String(held.employeeId),
      meta: { kind: held.kind, serial },
    });
    this.log.log(`certificate ${serial} issued to employee ${held.employeeId}`);
    await this.notices.raiseFor(held.employeeId, "REQUEST_DECIDED", { certificateId: held.id, approved: true });
    return this.db.certificate.findUniqueOrThrow({ where: { id: held.id } });
  }

  async reject(viewer: Viewer, id: string, body: DecideCertificateDto): Promise<Certificate> {
    const held = await this.decidable(viewer, id);
    const claimed = await this.db.certificate.updateMany({
      where: { id: held.id, state: "REQUESTED" },
      data: { state: "REJECTED", note: body.note ?? null, issuedById: viewer.userId },
    });
    if (claimed.count !== 1) {
      throw new BadRequestException("CERTIFICATE_ALREADY_DECIDED");
    }
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.CERTIFICATE_REJECT,
      subject: AUDIT_SUBJECTS.EMPLOYEE,
      subjectId: String(held.employeeId),
      meta: { kind: held.kind, note: body.note ?? null },
    });
    await this.notices.raiseFor(held.employeeId, "REQUEST_DECIDED", { certificateId: held.id, approved: false });
    return this.db.certificate.findUniqueOrThrow({ where: { id: held.id } });
  }

  /** The letter itself. Reading one is recorded: it carries somebody's pay. */
  async letter(viewer: Viewer, id: string): Promise<{ serial: string; text: string }> {
    const held = await this.db.certificate.findUnique({
      where: { id },
      include: {
        employee: {
          include: {
            jobTitle: { select: { name: true } },
            department: { select: { name: true } },
            legalEntity: { select: { name: true } },
            contracts: { where: { state: "ACTIVE" }, select: { kind: true }, take: 1 },
          },
        },
      },
    });
    if (!held) {
      throw new NotFoundException("CERTIFICATE_NOT_FOUND");
    }
    // It carries pay, a national id and a birth date, so a manager's tree does not reach it (KEHOACH 9.4).
    const visible = await this.scope.deskOrSelfEmployeeIds(viewer);
    if (visible !== null && !visible.includes(held.employeeId)) {
      throw new NotFoundException("CERTIFICATE_NOT_FOUND");
    }
    if (held.state !== "ISSUED" || held.serial === null) {
      throw new BadRequestException("CERTIFICATE_NOT_ISSUED");
    }
    const earnings = held.kind === "INCOME" ? await this.earningsOf(held.employeeId, held.months) : [];
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.CERTIFICATE_READ,
      subject: AUDIT_SUBJECTS.EMPLOYEE,
      subjectId: String(held.employeeId),
      meta: { serial: held.serial },
    });
    return {
      serial: held.serial,
      text: letterFor(held.kind, {
        serial: held.serial,
        issuedOn: asDay(held.issuedAt) ?? "",
        fullName: held.employee.fullName,
        code: held.employee.code,
        dateOfBirth: asDay(held.employee.dateOfBirth),
        nationalId: held.employee.nationalId,
        jobTitle: held.employee.jobTitle?.name ?? null,
        department: held.employee.department?.name ?? null,
        entity: held.employee.legalEntity?.name ?? null,
        hireDate: asDay(held.employee.hireDate),
        contract: held.employee.contracts[0]?.kind ?? null,
        purpose: held.purpose,
        earnings,
      }),
    };
  }

  // Monthly pay only: a bonus or a leaver's settlement is not the income a bank asks about.
  private async earningsOf(employeeId: number, months: number | null): Promise<Earnings[]> {
    const wanted = months ?? DEFAULT_MONTHS;
    const slips = await this.db.payslip.findMany({
      where: { employeeId, state: { in: ISSUED_SLIPS }, run: { kind: "REGULAR" } },
      include: { period: { select: { year: true, month: true } } },
      orderBy: [{ period: { year: "desc" } }, { period: { month: "desc" } }, { createdAt: "desc" }],
      take: wanted * 2,
    });
    const seen = new Set<string>();
    return slips
      .filter((one) => !seen.has(one.periodId) && Boolean(seen.add(one.periodId)))
      .slice(0, wanted)
      .map((one) => ({ year: one.period.year, month: one.period.month, net: one.netPay.toFixed(0) }));
  }

  private async decidable(viewer: Viewer, id: string): Promise<Certificate> {
    if (!DESK.includes(viewer.role)) {
      throw new ForbiddenException("HR_ONLY");
    }
    const held = await this.waiting(id);
    if (held.employeeId === viewer.employeeId) {
      throw new ForbiddenException("SELF_DECISION");
    }
    return held;
  }

  private async waiting(id: string): Promise<Certificate> {
    const held = await this.db.certificate.findUnique({ where: { id } });
    if (!held) {
      throw new NotFoundException("CERTIFICATE_NOT_FOUND");
    }
    if (held.state !== "REQUESTED") {
      throw new BadRequestException("CERTIFICATE_ALREADY_DECIDED");
    }
    return held;
  }
}
