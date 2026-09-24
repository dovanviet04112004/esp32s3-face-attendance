import { SetMetadata } from "@nestjs/common";

export const RATE_BUCKETS = "rate:buckets";

/** Count a route against named throttlers besides the global one; a bucket applies only where named (KEHOACH 7.2). */
export const RateBucket = (...buckets: string[]): MethodDecorator => SetMetadata(RATE_BUCKETS, buckets);
