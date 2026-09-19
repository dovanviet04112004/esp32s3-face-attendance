import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import type { Request } from "express";
import { tap, type Observable } from "rxjs";

import { AuditService } from "../../modules/audit/audit.service.js";

const READ_ONLY = new Set(["GET", "HEAD", "OPTIONS"]);

@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly audit: AuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request & { user?: { sub?: string } }>();
    if (READ_ONLY.has(req.method)) {
      return next.handle();
    }
    return next.handle().pipe(
      tap(() => {
        // Success only: a refused request leaves nothing behind, and a log of
        // attempts answers a different question.
        void this.audit.record({
          actorId: req.user?.sub,
          action: req.method,
          target: req.route?.path ?? req.path,
          meta: { params: req.params, query: req.query },
        });
      }),
    );
  }
}
