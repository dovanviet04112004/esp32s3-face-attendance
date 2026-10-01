import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Redis } from "ioredis";

import type { Env } from "../config/env.schema.js";

const QUICK_WAIT_MS = 250;

/** Owns the one Redis client; cache, queue and the auth guards borrow it (KEHOACH 4.6). */
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

  /** Run commands that may be skipped: null when Redis is away, slow or failing (KEHOACH 4.6). */
  async quick<T>(commands: (client: Redis) => Promise<T>): Promise<T | null> {
    if (this.client.status !== "ready") {
      return null;
    }
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), QUICK_WAIT_MS);
    });
    try {
      return await Promise.race([commands(this.client), late]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }
}
