import { Module } from "@nestjs/common";
import { ConfigModule, ConfigService } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import { PassportModule } from "@nestjs/passport";
import { ThrottlerModule } from "@nestjs/throttler";

import type { Env } from "../../config/env.schema.js";
import { AuthController } from "./auth.controller.js";
import { AuthService } from "./auth.service.js";
import { DeviceStrategy } from "./strategies/device.strategy.js";
import { JwtRefreshStrategy } from "./strategies/jwt-refresh.strategy.js";
import { JwtStrategy } from "./strategies/jwt.strategy.js";

const MINUTE_MS = 60_000;

@Module({
  imports: [
    PassportModule.register({}),
    JwtModule.register({}),
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>) => ({
        throttlers: [
          {
            limit: config.get("LOGIN_ATTEMPTS_PER_MINUTE", { infer: true }),
            ttl: MINUTE_MS,
          },
        ],
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, JwtStrategy, JwtRefreshStrategy, DeviceStrategy],
  exports: [AuthService],
})
export class AuthModule {}
