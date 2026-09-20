import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import type { BiometricConsent } from "@prisma/client";

import { ScopeService } from "../../common/scope/scope.service.js";
import type { Viewer } from "../../common/scope/viewer.js";
import { PrismaService } from "../../database/prisma.service.js";
import { AUDIT_ACTIONS, AUDIT_SUBJECTS } from "../audit/audit-actions.js";
import { AuditService } from "../audit/audit.service.js";
import type { GrantConsentDto } from "./dto/consent.dto.js";

const RECORDERS: ReadonlySet<string> = new Set(["ADMIN", "HR"]);

@Injectable()
export class ConsentService {
  constructor(
    private readonly db: PrismaService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
  ) {}

  live(employeeId: number): Promise<BiometricConsent | null> {
    return this.db.biometricConsent.findFirst({
      where: { employeeId, state: "GRANTED" },
      orderBy: { grantedAt: "desc" },
    });
  }

  /** Enrolment is refused without one, which is what makes this more than a
   *  form somebody filled in (KEHOACH 9.19).
   */
  async require(employeeId: number): Promise<void> {
    if ((await this.live(employeeId)) === null) {
      throw new ForbiddenException("BIOMETRIC_CONSENT_MISSING");
    }
  }

  async history(viewer: Viewer, employeeId: number): Promise<BiometricConsent[]> {
    const visible = await this.scope.visibleEmployeeIds(viewer);
    if (visible !== null && !visible.includes(employeeId)) {
      throw new NotFoundException("EMPLOYEE_NOT_FOUND");
    }
    return this.db.biometricConsent.findMany({
      where: { employeeId },
      orderBy: { grantedAt: "desc" },
    });
  }

  async grant(viewer: Viewer, body: GrantConsentDto): Promise<BiometricConsent> {
    const employeeId = body.employeeId ?? viewer.employeeId;
    if (employeeId === null || employeeId === undefined) {
      throw new NotFoundException("EMPLOYEE_NOT_FOUND");
    }
    if (employeeId !== viewer.employeeId && !RECORDERS.has(viewer.role)) {
      throw new ForbiddenException("CONSENT_NOT_YOURS");
    }
    if ((await this.live(employeeId)) !== null) {
      throw new BadRequestException("CONSENT_ALREADY_GRANTED");
    }
    const made = await this.db.biometricConsent.create({
      data: {
        employeeId,
        noticeVersion: body.noticeVersion,
        method: body.method,
        recordedById: viewer.userId,
        note: body.note ?? null,
      },
    });
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.BIOMETRIC_CONSENT_GRANT,
      subject: AUDIT_SUBJECTS.EMPLOYEE,
      subjectId: String(employeeId),
      meta: { noticeVersion: body.noticeVersion, method: body.method },
    });
    return made;
  }

  /** Withdrawing is a right, so it is one call and it takes effect at once. */
  async withdraw(viewer: Viewer, employeeId: number): Promise<BiometricConsent> {
    if (employeeId !== viewer.employeeId && !RECORDERS.has(viewer.role)) {
      throw new ForbiddenException("CONSENT_NOT_YOURS");
    }
    const held = await this.live(employeeId);
    if (!held) {
      throw new BadRequestException("CONSENT_NOT_GRANTED");
    }
    const dropped = await this.db.biometricConsent.update({
      where: { id: held.id },
      data: { state: "WITHDRAWN", withdrawnAt: new Date() },
    });
    await this.audit.record({
      actorId: viewer.userId,
      action: AUDIT_ACTIONS.BIOMETRIC_CONSENT_WITHDRAW,
      subject: AUDIT_SUBJECTS.EMPLOYEE,
      subjectId: String(employeeId),
    });
    return dropped;
  }
}
