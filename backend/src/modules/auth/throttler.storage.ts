import { Injectable, Logger } from "@nestjs/common";
import type { ThrottlerStorage } from "@nestjs/throttler";

import { RATE } from "../../common/cache/cache-keys.js";
import { RedisService } from "../../database/redis.service.js";

type Tally = Awaited<ReturnType<ThrottlerStorage["increment"]>>;
type Tallied = [hits: number, windowLeftMs: number, blockLeftMs: number];

const MS_PER_SECOND = 1000;
const WARN_EVERY_MS = 60_000;

// KEYS: hits, block. ARGV: window ms, limit, block ms. Returns hits, window ms left, block ms left.
const COUNT = `
local hits = redis.call('INCR', KEYS[1])
local left = redis.call('PTTL', KEYS[1])
if left < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  left = tonumber(ARGV[1])
end
local blocked = redis.call('PTTL', KEYS[2])
if blocked < 0 and hits > tonumber(ARGV[2]) then
  redis.call('SET', KEYS[2], '1', 'PX', ARGV[3])
  blocked = tonumber(ARGV[3])
end
return { hits, left, blocked }
`;

/** Rate counters in Redis, so every replica and every restart sees one count (KEHOACH 7.2). */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly log = new Logger(RedisThrottlerStorage.name);
  private warnedAt = 0;

  constructor(private readonly redis: RedisService) {}

  async increment(key: string, ttl: number, limit: number, blockDuration: number, bucket: string): Promise<Tally> {
    const keys = [RATE.hits(bucket, key), RATE.block(bucket, key)];
    const counted = await this.redis.quick(
      (client) => client.eval(COUNT, keys.length, ...keys, ttl, limit, blockDuration) as Promise<Tallied>,
    );
    if (counted === null) {
      this.warnOpen();
      return { totalHits: 0, timeToExpire: Math.ceil(ttl / MS_PER_SECOND), isBlocked: false, timeToBlockExpire: 0 };
    }
    const [hits, left, blocked] = counted;
    return {
      totalHits: hits,
      timeToExpire: Math.ceil(left / MS_PER_SECOND),
      isBlocked: blocked > 0,
      timeToBlockExpire: Math.ceil(Math.max(blocked, 0) / MS_PER_SECOND),
    };
  }

  private warnOpen(): void {
    const now = Date.now();
    if (now - this.warnedAt < WARN_EVERY_MS) {
      return;
    }
    this.warnedAt = now;
    this.log.warn("redis did not answer; rate limits are open until it does");
  }
}
