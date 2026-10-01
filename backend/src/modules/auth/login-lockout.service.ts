import { createHash } from "node:crypto";

import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { normalizeIp } from "@nestjs/throttler";
import type { Redis } from "ioredis";

import { GUARD } from "../../common/cache/cache-keys.js";
import type { Env } from "../../config/env.schema.js";
import { RedisService } from "../../database/redis.service.js";
import { AUDIT_ACTIONS, AUDIT_SUBJECTS } from "../audit/audit-actions.js";
import { AuditService } from "../audit/audit.service.js";

const SECONDS_PER_MINUTE = 60;
const SECONDS_PER_HOUR = 3600;

/** The one spelling of an address that sign-in looks up and the lock counts (KEHOACH 7.2). */
export function normalEmail(email: string): string {
  return email.trim().toLowerCase();
}

// Keyed by the address typed, known or not, so a lock tells nobody which accounts exist (KEHOACH 7.2).
function hashOf(email: string): string {
  return createHash("sha256").update(normalEmail(email)).digest("hex");
}

function addressKey(address: string | undefined): string {
  return GUARD.addressMisses(normalizeIp(address ?? "unknown"));
}

async function count(client: Redis, key: string, windowSeconds: number): Promise<number> {
  const replies = await client.multi().incr(key).expire(key, windowSeconds, "NX").exec();
  return Number(replies?.[0]?.[1] ?? 0);
}

/** Misses on one email whatever address they come from, and misses from one address over every email (KEHOACH 7.2). */
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
    const left = await this.redis.quick((client) => client.ttl(GUARD.loginLock(hashOf(email))));
    return left !== null && left > 0 ? left : 0;
  }

  /** Whether this address has missed too often, over every email, to try again in this window. */
  async addressSpent(address: string | undefined): Promise<boolean> {
    const misses = await this.redis.quick((client) => client.get(addressKey(address)));
    return misses !== null && Number(misses) >= this.config.get("LOGIN_IP_MISSES", { infer: true });
  }

  /** Count one miss; the miss that reaches the limit closes the email for a while. */
  async missed(email: string, userId: string | null, address: string | undefined): Promise<void> {
    const key = hashOf(email);
    const window = this.config.get("LOGIN_LOCK_MINUTES", { infer: true }) * SECONDS_PER_MINUTE;
    const lockAfter = this.config.get("LOGIN_LOCK_AFTER", { infer: true });
    const locked = await this.redis.quick(async (client) => {
      await count(client, addressKey(address), window);
      if ((await count(client, GUARD.loginMisses(key), window)) < lockAfter) {
        return false;
      }
      await client.multi().set(GUARD.loginLock(key), "1", "EX", window).del(GUARD.loginMisses(key)).exec();
      return true;
    });
    if (locked === null) {
      this.log.warn("a missed login went uncounted");
      return;
    }
    if (locked && userId !== null) {
      await this.audit.record({
        action: AUDIT_ACTIONS.USER_LOCKED,
        subject: AUDIT_SUBJECTS.USER,
        subjectId: userId,
        meta: { minutes: window / SECONDS_PER_MINUTE },
      });
    }
  }

  /** Count one setup letter to this address, known or not; false once it has had its hour's share (KEHOACH 9.4). */
  async mayMail(email: string): Promise<boolean> {
    const key = GUARD.recipientLinks(hashOf(email));
    const sent = await this.redis.quick((client) => count(client, key, SECONDS_PER_HOUR));
    return sent === null || sent <= this.config.get("FORGOT_PER_EMAIL_PER_HOUR", { infer: true });
  }

  /** Forget the misses and any lock on this email, once the owner has proved who they are. */
  async clear(email: string): Promise<void> {
    const key = hashOf(email);
    const cleared = await this.redis.quick((client) => client.del(GUARD.loginMisses(key), GUARD.loginLock(key)));
    if (cleared === null) {
      this.log.warn("login misses not cleared");
    }
  }
}
