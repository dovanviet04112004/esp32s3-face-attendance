import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { BiometricConsent } from "@prisma/client";

import type { Env } from "../../config/env.schema.js";
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
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** The notice on offer right now, which a consent record is stamped with. */
  noticeVersion(): string {
    return this.config.get("BIOMETRIC_NOTICE_VERSION", { infer: true });
  }

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
    this.mayRecordFor(viewer, employeeId);
    if ((await this.live(employeeId)) !== null) {
      throw new BadRequestException("CONSENT_ALREADY_GRANTED");
    }
    // The server names the text on offer; a client-sent version could name a notice nobody saw.
    const noticeVersion = this.noticeVersion();
    const made = await this.db.biometricConsent.create({
      data: {
        employeeId,
        noticeVersion,
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
      meta: { noticeVersion, method: body.method },
    });
    return made;
  }

  /** A person records for themselves; only the desk records for someone else. */
  mayRecordFor(viewer: Viewer, employeeId: number): void {
    if (employeeId !== viewer.employeeId && !RECORDERS.has(viewer.role)) {
      throw new ForbiddenException("CONSENT_NOT_YOURS");
    }
  }
}
