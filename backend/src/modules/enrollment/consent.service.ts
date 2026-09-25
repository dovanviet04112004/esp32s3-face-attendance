import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { BiometricConsent, Prisma } from "@prisma/client";

import type { Env } from "../../config/env.schema.js";
import { ScopeService } from "../../common/scope/scope.service.js";
import type { Viewer } from "../../common/scope/viewer.js";
import { PrismaService } from "../../database/prisma.service.js";
import { AUDIT_ACTIONS, AUDIT_SUBJECTS } from "../audit/audit-actions.js";
import { AuditService, type AuditEntry } from "../audit/audit.service.js";
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
    await this.audit.record(this.grantLine(viewer.userId, employeeId, body.method));
    return made;
  }

  /** Record a consent for each of these people who holds none in force, as the profile's button does.
   *  @ctx inside the caller's transaction | audit the answer with grantTrail once it commits (KEHOACH 9.20 rule 3)
   *  @ret the people it wrote a consent for
   */
  async stageGrants(
    tx: Prisma.TransactionClient,
    recordedById: string,
    employeeIds: readonly number[],
    method: GrantConsentDto["method"],
  ): Promise<number[]> {
    if (employeeIds.length === 0) {
      return [];
    }
    const made = await tx.$queryRaw<{ employeeId: number }[]>`
      INSERT INTO "BiometricConsent" ("id", "employeeId", "noticeVersion", "method", "recordedById")
      SELECT gen_random_uuid()::text, v."id", ${this.noticeVersion()}, ${method}, ${recordedById}
        FROM unnest(${[...employeeIds]}::int[]) AS v("id")
       WHERE NOT EXISTS (
         SELECT 1 FROM "BiometricConsent" c WHERE c."employeeId" = v."id" AND c."state" = 'GRANTED')
      RETURNING "employeeId"
    `;
    return made.map((one) => one.employeeId);
  }

  /** The trail line the profile's button leaves, one per person stageGrants wrote for. */
  grantTrail(actorId: string, employeeIds: readonly number[], method: GrantConsentDto["method"]): AuditEntry[] {
    return employeeIds.map((employeeId) => this.grantLine(actorId, employeeId, method));
  }

  private grantLine(actorId: string, employeeId: number, method: GrantConsentDto["method"]): AuditEntry {
    return {
      actorId,
      action: AUDIT_ACTIONS.BIOMETRIC_CONSENT_GRANT,
      subject: AUDIT_SUBJECTS.EMPLOYEE,
      subjectId: String(employeeId),
      meta: { noticeVersion: this.noticeVersion(), method },
    };
  }

  /** A person records for themselves; only the desk records for someone else. */
  mayRecordFor(viewer: Viewer, employeeId: number): void {
    if (employeeId !== viewer.employeeId && !RECORDERS.has(viewer.role)) {
      throw new ForbiddenException("CONSENT_NOT_YOURS");
    }
  }
}
