import { randomUUID, createHash } from "node:crypto";

import { Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import type { User } from "@prisma/client";

import type { Env } from "../../config/env.schema.js";
import { PrismaService } from "../../database/prisma.service.js";
import type { AccessClaims, DeviceClaims, RefreshClaims } from "./auth.types.js";
import { verifyPassword } from "./password.js";

/** A signed pair, plus the lifetime the cookie should carry. */
export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
}

@Injectable()
export class AuthService {
  private readonly log = new Logger(AuthService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  async signIn(email: string, password: string): Promise<IssuedTokens> {
    const user = await this.db.user.findUnique({ where: { email } });
    // The same answer whether the address is unknown or the password is wrong,
    // so a caller cannot learn which addresses exist.
    const ok = user ? await verifyPassword(password, user.passwordHash) : false;
    if (!user || !ok) {
      throw new UnauthorizedException("email or password is wrong");
    }
    return this.issue(user);
  }

  /** Trade a refresh token for a new pair. A jti that misses the stored hash
   *  is a replay of a spent token, and drops the whole session.
   */
  async rotate(claims: RefreshClaims): Promise<IssuedTokens> {
    const user = await this.db.user.findUnique({ where: { id: claims.sub } });
    if (!user?.refreshTokenHash || user.refreshTokenHash !== fingerprint(claims.jti)) {
      if (user) {
        await this.revoke(user.id);
        this.log.warn(`refresh replayed for ${user.email}, session dropped`);
      }
      throw new UnauthorizedException("refresh token is not the current one");
    }
    return this.issue(user);
  }

  async revoke(userId: string): Promise<void> {
    await this.db.user.update({
      where: { id: userId },
      data: { refreshTokenHash: null },
    });
  }

  /** Sign a kiosk token; E13-T9 hands it out after an admin approves. */
  signDevice(claims: DeviceClaims): string {
    const days = this.config.get("DEVICE_TOKEN_TTL_DAYS", { infer: true });
    return this.jwt.sign(claims, {
      secret: this.config.get("JWT_DEVICE_SECRET", { infer: true }),
      expiresIn: `${days}d`,
    });
  }

  private async issue(user: User): Promise<IssuedTokens> {
    const jti = randomUUID();
    const access: AccessClaims = {
      sub: user.id,
      role: user.role,
      ...(user.employeeId !== null ? { employeeId: user.employeeId } : {}),
    };
    const refresh: RefreshClaims = { sub: user.id, jti };
    const accessToken = this.jwt.sign(access, {
      secret: this.config.get("JWT_ACCESS_SECRET", { infer: true }),
      expiresIn: this.config.get("JWT_ACCESS_TTL", { infer: true }),
    });
    const refreshToken = this.jwt.sign(refresh, {
      secret: this.config.get("JWT_REFRESH_SECRET", { infer: true }),
      expiresIn: this.config.get("JWT_REFRESH_TTL", { infer: true }),
    });
    await this.db.user.update({
      where: { id: user.id },
      data: { refreshTokenHash: fingerprint(jti) },
    });
    return { accessToken, refreshToken };
  }
}

function fingerprint(jti: string): string {
  return createHash("sha256").update(jti).digest("hex");
}
