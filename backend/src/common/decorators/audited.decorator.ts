import { SetMetadata } from "@nestjs/common";

export const NOT_AUDITED = "notAudited";

/** Mark a write whose success is not a decision anybody traces back later. */
export const NotAudited = (): MethodDecorator => SetMetadata(NOT_AUDITED, true);

export const AUDITED_IN_SERVICE = "auditedInService";

/** Mark a write whose service records its own entry on every path that succeeds, so the
 *  interceptor adds no `route` row beside it (KEHOACH 9.24 rule 5).
 */
export const AuditedInService = (): MethodDecorator => SetMetadata(AUDITED_IN_SERVICE, true);
