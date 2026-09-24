import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";
import { ApiOperation, ApiTags } from "@nestjs/swagger";
import { SkipThrottle } from "@nestjs/throttler";

import { PrismaService } from "../../database/prisma.service.js";
import { RedisService } from "../../database/redis.service.js";
import { THROTTLE } from "../auth/auth.types.js";

// Redis queues a command for as long as it is down (maxRetriesPerRequest: null),
// so a probe without a deadline would hang the very check that should fail.
const PROBE_TIMEOUT_MS = 2000;

async function answers(probe: PromiseLike<unknown>): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), PROBE_TIMEOUT_MS);
  });
  const settled = Promise.resolve(probe).then(
    () => true,
    () => false,
  );
  const answered = await Promise.race([settled, late]);
  clearTimeout(timer);
  return answered;
}

/** The deploy script and the compose healthcheck wait on this (KEHOACH 4.8). */
@ApiTags("health")
@Controller("health")
export class HealthController {
  constructor(
    private readonly db: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get()
  @SkipThrottle({ [THROTTLE.api]: true })
  @ApiOperation({ summary: "Whether Postgres and Redis answer; the broker is not asked" })
  async check(): Promise<{ status: "ok" }> {
    const [database, cache] = await Promise.all([
      answers(this.db.$queryRaw`SELECT 1`),
      answers(this.redis.client.ping()),
    ]);
    if (!database || !cache) {
      throw new ServiceUnavailableException("DEPENDENCY_DOWN");
    }
    return { status: "ok" };
  }
}
