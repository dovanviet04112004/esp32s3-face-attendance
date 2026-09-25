import { createHash } from "node:crypto";

import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";

import { GUARD } from "../../common/cache/cache-keys.js";
import type { Env } from "../../config/env.schema.js";
import { RedisService } from "../../database/redis.service.js";
import { AUDIT_ACTIONS, AUDIT_SUBJECTS } from "../audit/audit-actions.js";
import { AuditService } from "../audit/audit.service.js";

const SECONDS_PER_MINUTE = 60;

/** The one spelling of an address that sign-in looks up and the lock counts (KEHOACH 7.2). */
export function normalEmail(email: string): string {
  return email.trim().toLowerCase();
}

// Keyed by the address typed, known or not, so a lock tells nobody which accounts exist (KEHOACH 7.2).
function hashOf(email: string): string {
  return createHash("sha256").update(normalEmail(email)).digest("hex");
}

/** Misses on one email in a row, whatever address they come from (KEHOACH 7.2). */
@Injectable()
export class LoginLockout {
  private readonly log = new Logger(LoginLockout.name);

  constructor(
    private readonly redis: RedisService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /** Seconds left on this email's lock, 0 when it may try. */
  async lockedFor(email: string): Promise<number> {
    try {
      const left = await this.redis.client.ttl(GUARD.loginLock(hashOf(email)));
      return left > 0 ? left : 0;
    } catch {
      this.log.warn("lock check failed, letting the attempt through");
      return 0;
    }
  }

  /** Count one miss; the miss that reaches the limit closes the email for a while. */
  async missed(email: string, userId: string | null): Promise<void> {
    const key = hashOf(email);
    const window = this.config.get("LOGIN_LOCK_MINUTES", { infer: true }) * SECONDS_PER_MINUTE;
    try {
      const misses = await this.redis.client.incr(GUARD.loginMisses(key));
      if (misses === 1) {
        await this.redis.client.expire(GUARD.loginMisses(key), window);
      }
      if (misses < this.config.get("LOGIN_LOCK_AFTER", { infer: true })) {
        return;
      }
      await this.redis.client.set(GUARD.loginLock(key), "1", "EX", window);
      await this.redis.client.del(GUARD.loginMisses(key));
    } catch {
      this.log.warn("a missed login went uncounted");
      return;
    }
    if (userId !== null) {
      await this.audit.record({
        action: AUDIT_ACTIONS.USER_LOCKED,
        subject: AUDIT_SUBJECTS.USER,
        subjectId: userId,
        meta: { minutes: window / SECONDS_PER_MINUTE },
      });
    }
  }

  /** Forget the misses and any lock, once the owner has proved who they are. */
  async clear(email: string): Promise<void> {
    const key = hashOf(email);
    try {
      await this.redis.client.del(GUARD.loginMisses(key), GUARD.loginLock(key));
    } catch {
      this.log.warn("login misses not cleared");
    }
  }
}
