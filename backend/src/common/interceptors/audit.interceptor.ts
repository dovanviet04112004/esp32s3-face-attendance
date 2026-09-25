import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { tap, type Observable } from "rxjs";

import { AUDIT_ACTIONS, AUDIT_SUBJECTS } from "../../modules/audit/audit-actions.js";
import { AuditService } from "../../modules/audit/audit.service.js";
import { AUDITED_IN_SERVICE, NOT_AUDITED } from "../decorators/audited.decorator.js";

const READ_ONLY = new Set(["GET", "HEAD", "OPTIONS"]);
const ACTOR = Symbol("auditActor");

type Traced = Request & { user?: { sub?: string }; [ACTOR]?: string };

/** Name who acted on a request no token vouched for, as a login does once the password checks. */
export function actedAs(req: Request, userId: string): void {
  (req as Traced)[ACTOR] = userId;
}

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(
    private readonly audit: AuditService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Traced>();
    const targets = [context.getHandler(), context.getClass()];
    const skip =
      this.reflector.getAllAndOverride<boolean>(NOT_AUDITED, targets) ||
      this.reflector.getAllAndOverride<boolean>(AUDITED_IN_SERVICE, targets);
    if (READ_ONLY.has(req.method) || skip) {
      return next.handle();
    }
    return next.handle().pipe(
      tap(() => {
        // Success only: a refused request leaves nothing behind, and a log of
        // attempts answers a different question.
        void this.audit.record({
          actorId: req.user?.sub ?? req[ACTOR],
          action: AUDIT_ACTIONS.ROUTE_WRITE,
          subject: AUDIT_SUBJECTS.ROUTE,
          subjectId: req.route?.path ?? req.path,
          meta: { method: req.method, params: req.params, query: req.query },
        });
      }),
    );
  }
}
