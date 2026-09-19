import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Redis } from "ioredis";

import type { Env } from "../config/env.schema.js";

/** Owns the one Redis client; cache and queue both borrow it (KEHOACH 4.6). */
@Injectable()
export class RedisService implements OnModuleDestroy {
  readonly client: Redis;

  constructor(config: ConfigService<Env, true>) {
    this.client = new Redis(config.get("REDIS_URL", { infer: true }), {
      // BullMQ blocks on its own connection and refuses a capped retry.
      maxRetriesPerRequest: null,
      lazyConnect: false,
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }
}
