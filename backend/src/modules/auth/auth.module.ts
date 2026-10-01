import { Module, type ExecutionContext } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { APP_GUARD } from "@nestjs/core";
import { JwtModule, JwtService } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { normalizeIp, ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";

import { RATE_BUCKETS } from "../../common/decorators/rate-bucket.decorator.js";
import type { Env } from "../../config/env.schema.js";
import { RedisService } from "../../database/redis.service.js";
import { AuthController } from "./auth.controller.js";
import { JWT_ALGORITHM, THROTTLE, type AccessClaims } from "./auth.types.js";
import { AuthService } from "./auth.service.js";
import { LoginLockout } from "./login-lockout.service.js";
import { MfaService } from "./mfa.service.js";
import { DeviceStrategy } from "./strategies/device.strategy.js";
import { JwtRefreshStrategy } from "./strategies/jwt-refresh.strategy.js";
import { JwtStrategy } from "./strategies/jwt.strategy.js";
import { RedisThrottlerStorage } from "./throttler.storage.js";

const MINUTE_MS = 60_000;
const BEARER = "Bearer ";

// Only the global bucket counts everywhere; a named one counts where a route names it.
function unless(bucket: string): (context: ExecutionContext) => boolean {
  return (context) => {
    const named: string[] = Reflect.getMetadata(RATE_BUCKETS, context.getHandler()) ?? [];
    return !named.includes(bucket);
  };
}

function byAddress(req: Record<string, any>): string {
  return `ip:${normalizeIp(String(req.ip))}`;
}

// A subject is trusted only once its signature checks, or a forged one per request evades the count (KEHOACH 7.2).
function byAccount(secret: string): (req: Record<string, any>) => string {
  const jwt = new JwtService();
  return (req) => {
    const header: unknown = req.headers?.authorization;
    const token = typeof header === "string" && header.startsWith(BEARER) ? header.slice(BEARER.length) : "";
    try {
      return token ? `user:${jwt.verify<AccessClaims>(token, { secret, algorithms: [JWT_ALGORITHM] }).sub}` : byAddress(req);
    } catch {
      return byAddress(req);
    }
  };
}

@Module({
  imports: [
    PassportModule.register({}),
    JwtModule.register({}),
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService, RedisService],
      useFactory: (config: ConfigService<Env, true>, redis: RedisService) => {
        const account = byAccount(config.get("JWT_ACCESS_SECRET", { infer: true }));
        return {
          errorMessage: "RATE_LIMITED",
          storage: new RedisThrottlerStorage(redis),
          // One count per bucket and caller, whichever route spends it (KEHOACH 7.2).
          generateKey: (_context: ExecutionContext, caller: string) => caller,
          getTracker: byAddress,
          throttlers: [
            {
              name: THROTTLE.api,
              limit: config.get("API_REQUESTS_PER_MINUTE", { infer: true }),
              ttl: MINUTE_MS,
              getTracker: account,
            },
            {
              name: THROTTLE.heavy,
              limit: config.get("HEAVY_REQUESTS_PER_MINUTE", { infer: true }),
              ttl: MINUTE_MS,
              getTracker: account,
              skipIf: unless(THROTTLE.heavy),
            },
            {
              name: THROTTLE.search,
              limit: config.get("SEARCH_REQUESTS_PER_MINUTE", { infer: true }),
              ttl: MINUTE_MS,
              getTracker: account,
              skipIf: unless(THROTTLE.search),
            },
            {
              name: THROTTLE.login,
              limit: config.get("LOGIN_ATTEMPTS_PER_MINUTE", { infer: true }),
              ttl: MINUTE_MS,
              skipIf: unless(THROTTLE.login),
            },
            {
              name: THROTTLE.deviceRegister,
              limit: config.get("DEVICE_REGISTER_ATTEMPTS_PER_MINUTE", { infer: true }),
              ttl: MINUTE_MS,
              skipIf: unless(THROTTLE.deviceRegister),
            },
            {
              name: THROTTLE.forgot,
              limit: config.get("FORGOT_ATTEMPTS_PER_HOUR", { infer: true }),
              ttl: MINUTE_MS * 60,
              skipIf: unless(THROTTLE.forgot),
            },
            {
              name: THROTTLE.mfa,
              limit: config.get("MFA_ATTEMPTS_PER_MINUTE", { infer: true }),
              ttl: MINUTE_MS,
              skipIf: unless(THROTTLE.mfa),
            },
          ],
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    LoginLockout,
    MfaService,
    JwtStrategy,
    JwtRefreshStrategy,
    DeviceStrategy,
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
  // Re-exported so a module with a guarded controller gets the one
  // registration rather than starting its own.
  exports: [AuthService, MfaService, PassportModule],
})
export class AuthModule {}
