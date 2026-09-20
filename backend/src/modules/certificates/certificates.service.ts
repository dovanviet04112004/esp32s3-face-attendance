import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import type { Certificate, Prisma } from "@prisma/client";

import { COUNT_CEILING, countedTo } from "../../common/dto/cursor.dto.js";
import type { Page } from "../../common/dto/pagination.dto.js";
import { ScopeService } from "../../common/scope/scope.service.js";
import type { Viewer } from "../../common/scope/viewer.js";
import { PrismaService } from "../../database/prisma.service.js";
import { AUDIT_ACTIONS, AUDIT_SUBJECTS } from "../audit/audit-actions.js";
import { AuditService } from "../audit/audit.service.js";
import { letterFor, type Earnings } from "./certificate-text.js";
import type { AskCertificateDto, DecideCertificateDto, ListCertificatesDto } from "./dto/certificate.dto.js";

const DESK = ["ADMIN", "HR", "PAYROLL"];
const SERIAL_DIGITS = 5;
const DEFAULT_MONTHS = 3;

function asDay(value: Date | null): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

@Injectable()
export class CertificatesService {
  private readonly log = new Logger(CertificatesService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
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
    return made;
  }

  async list(viewer: Viewer, query: ListCertificatesDto): Promise<Page<Certificate>> {
    const visible = await this.scope.visibleEmployeeIds(viewer);
    const where: Prisma.CertificateWhereInput = {
      ...ScopeService.narrow("employeeId", visible),
      ...(query.state ? { state: query.state } : {}),
    };
    const [rows, found] = await Promise.all([
      this.db.certificate.findMany({
        where,
        skip: query.skip,
        take: query.take,
        orderBy: { createdAt: "desc" },
        include: { employee: { select: { code: true, fullName: true } } },
      }),
      this.db.certificate.count({ where, take: COUNT_CEILING + 1 }),
    ]);
    return { rows, ...countedTo(found) };
  }

  /**
   * Hand one out. The serial comes from the database rather than a count of
   * rows, so two people issuing at once cannot be given the same number
   * (KEHOACH 9.23 rule 2).
   */
  async issue(viewer: Viewer, id: string): Promise<Certificate> {
    this.deskOnly(viewer);
    const held = await this.waiting(id);
    const [next] = await this.db.$queryRaw<{ n: bigint }[]>`
      SELECT nextval('certificate_serial_seq') AS n
    `;
    const year = new Date().getUTCFullYear();
    const serial = `${year}/${String(next.n).padStart(SERIAL_DIGITS, "0")}`;
    const given = await this.db.certificate.update({
      where: { id: held.id },
      data: { state: "ISSUED", serial, issuedAt: new Date(), issuedById: viewer.userId },
    });
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.CERTIFICATE_ISSUE,
      subject: AUDIT_SUBJECTS.EMPLOYEE,
      subjectId: String(held.employeeId),
      meta: { kind: held.kind, serial },
    });
    this.log.log(`certificate ${serial} issued to employee ${held.employeeId}`);
    return given;
  }

  async reject(viewer: Viewer, id: string, body: DecideCertificateDto): Promise<Certificate> {
    this.deskOnly(viewer);
    const held = await this.waiting(id);
    const turned = await this.db.certificate.update({
      where: { id: held.id },
      data: { state: "REJECTED", note: body.note ?? null, issuedById: viewer.userId },
    });
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.CERTIFICATE_REJECT,
      subject: AUDIT_SUBJECTS.EMPLOYEE,
      subjectId: String(held.employeeId),
      meta: { kind: held.kind, note: body.note ?? null },
    });
    return turned;
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
    const visible = await this.scope.visibleEmployeeIds(viewer);
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
        entity: held.employee.legalEntity?.name ?? "Công ty",
        hireDate: asDay(held.employee.hireDate),
        contract: held.employee.contracts[0]?.kind ?? null,
        purpose: held.purpose,
        earnings,
      }),
    };
  }

  private async earningsOf(employeeId: number, months: number | null): Promise<Earnings[]> {
    const slips = await this.db.payslip.findMany({
      where: { employeeId, state: { in: ["ISSUED", "SENT"] } },
      include: { period: { select: { year: true, month: true } } },
      orderBy: [{ period: { year: "desc" } }, { period: { month: "desc" } }],
      take: months ?? DEFAULT_MONTHS,
    });
    return slips.map((one) => ({
      year: one.period.year,
      month: one.period.month,
      net: one.netPay.toFixed(0),
    }));
  }

  private deskOnly(viewer: Viewer): void {
    if (!DESK.includes(viewer.role)) {
      throw new ForbiddenException("HR_ONLY");
    }
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
