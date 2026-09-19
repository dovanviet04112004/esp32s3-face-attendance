import { Injectable, Logger } from "@nestjs/common";

import { RedisService } from "../../database/redis.service.js";
import type { CacheEntry } from "./cache-keys.js";

@Injectable()
export class CacheService {
  private readonly log = new Logger(CacheService.name);

  constructor(private readonly redis: RedisService) {}

  /** Read through: losing Redis costs a trip to Postgres and nothing else. */
  async through<T>(entry: CacheEntry, build: () => Promise<T>): Promise<T> {
    try {
      const held = await this.redis.client.get(entry.key);
      if (held !== null) {
        return JSON.parse(held) as T;
      }
    } catch {
      this.log.warn(`cache read for ${entry.key} failed, going to the database`);
    }
    const fresh = await build();
    try {
      await this.redis.client.set(entry.key, JSON.stringify(fresh), "EX", entry.ttlSeconds);
    } catch {
      this.log.warn(`cache write for ${entry.key} failed`);
    }
    return fresh;
  }

  async drop(prefix: string): Promise<void> {
    const keys = await this.redis.client.keys(`${prefix}*`);
    if (keys.length > 0) {
      await this.redis.client.del(...keys);
    }
  }
}
