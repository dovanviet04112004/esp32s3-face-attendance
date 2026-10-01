import { Injectable, Logger } from "@nestjs/common";

import { RedisService } from "../../database/redis.service.js";
import type { CacheEntry } from "./cache-keys.js";

@Injectable()
export class CacheService {
  private readonly log = new Logger(CacheService.name);

  constructor(private readonly redis: RedisService) {}

  /** Read through: losing Redis costs a trip to Postgres and nothing else (KEHOACH 4.6). */
  async through<T>(entry: CacheEntry, build: () => Promise<T>): Promise<T> {
    const held = await this.redis.quick((client) => client.get(entry.key));
    if (held !== null) {
      return JSON.parse(held) as T;
    }
    const fresh = await build();
    const written = await this.redis.quick((client) =>
      client.set(entry.key, JSON.stringify(fresh), "EX", entry.ttlSeconds),
    );
    if (written === null) {
      this.log.warn(`cache write for ${entry.key} failed`);
    }
    return fresh;
  }

  async drop(prefix: string): Promise<void> {
    const dropped = await this.redis.quick(async (client) => {
      const keys = await client.keys(`${prefix}*`);
      return keys.length > 0 ? client.del(...keys) : 0;
    });
    if (dropped === null) {
      this.log.warn(`cache entries under ${prefix} kept; they expire on their own`);
    }
  }
}
