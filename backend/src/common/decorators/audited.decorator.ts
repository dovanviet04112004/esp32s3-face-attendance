import { SetMetadata } from "@nestjs/common";

export const NOT_AUDITED = "notAudited";

/** Mark a write whose success is not a decision anybody traces back later. */
export const NotAudited = (): MethodDecorator => SetMetadata(NOT_AUDITED, true);
