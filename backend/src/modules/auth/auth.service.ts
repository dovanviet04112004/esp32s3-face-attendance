import { randomBytes, randomUUID, createHash, timingSafeEqual } from "node:crypto";

import { Inject, Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import type { User } from "@prisma/client";

import type { Env } from "../../config/env.schema.js";
import { PrismaService } from "../../database/prisma.service.js";
import type { AccessClaims, DeviceClaims, RefreshClaims } from "./auth.types.js";
import { QUEUE_TOKEN, type Queues } from "../../queue/queue.module.js";
import { QUEUE, type PasswordSetupJob } from "../../queue/queues.js";
import { DEFAULT_MAIL_LOCALE } from "../payroll/mail-text.js";
import { hashPassword, LINK_BYTES, verifyPassword } from "./password.js";

const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Read a jwt lifetime like `7d`, so no row or cookie outlives its token. */
export function ttlToMs(ttl: string): number {
  const match = /^(\d+)([smhd])$/.exec(ttl);
  return match ? Number(match[1]) * UNIT_MS[match[2]] : Number(ttl) * 1000;
}

/** The sha256 a device row keeps of the ticket it holds (KEHOACH 7.3). */
export function deviceFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function sameFingerprint(given: string, kept: string | null): boolean {
  if (kept === null) {
    return false;
  }
  const a = Buffer.from(given, "hex");
  const b = Buffer.from(kept, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
}

/** What the session row records about the device it belongs to. */
export interface SignedInFrom {
  userAgent?: string;
  ip?: string;
}

@Injectable()
export class AuthService {
  private readonly log = new Logger(AuthService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
    @Inject(QUEUE_TOKEN) private readonly queues: Queues,
  ) {}

  async signIn(email: string, password: string, from: SignedInFrom): Promise<IssuedTokens> {
    const user = await this.db.user.findUnique({ where: { email } });
    // The same answer whether the address is unknown or the password is wrong,
    // so a caller cannot learn which addresses exist.
    const ok = user ? await verifyPassword(password, user.passwordHash) : false;
    // A closed account answers like a wrong password on purpose: the caller
    // has proved nothing yet, so it must not learn the address exists.
    if (!user || !ok || !user.active) {
      throw new UnauthorizedException("CREDENTIALS_REJECTED");
    }
    await this.makeRoom(user.id);
    return this.issue(user, null, from);
  }

  /** Trade a refresh token for a new pair. A jti that misses the hash its own
   *  session holds is a replay, and costs that one device its session.
   */
  async rotate(claims: RefreshClaims): Promise<IssuedTokens> {
    const session = await this.db.session.findUnique({
      where: { id: claims.sid },
      include: { user: true },
    });
    const now = new Date();
    if (
      !session ||
      session.userId !== claims.sub ||
      session.revokedAt !== null ||
      session.expiresAt <= now
    ) {
      throw new UnauthorizedException("SESSION_CLOSED");
    }
    if (session.tokenHash !== fingerprint(claims.jti)) {
      // The other devices proved nothing wrong, so they keep their rows.
      await this.close(session.id);
      this.log.warn(`refresh replayed on session ${session.id}, that device signed out`);
      throw new UnauthorizedException("REFRESH_REPLAYED");
    }
    if (!session.user.active) {
      await this.closeAll(session.userId);
      throw new UnauthorizedException("ACCOUNT_CLOSED");
    }
    return this.issue(session.user, session.id, {});
  }

  /** Redeem a one-time link; spending it closes it (KEHOACH 9.4). */
  async setPassword(token: string, password: string): Promise<void> {
    const setup = await this.db.passwordSetup.findUnique({
      where: { tokenHash: fingerprint(token) },
      include: { user: { select: { id: true, active: true } } },
    });
    const now = new Date();
    if (!setup || setup.usedAt !== null || setup.expiresAt <= now || !setup.user.active) {
      throw new UnauthorizedException("SETUP_LINK_SPENT");
    }
    const passwordHash = await hashPassword(password);
    await this.db.$transaction([
      this.db.passwordSetup.update({ where: { id: setup.id }, data: { usedAt: now } }),
      this.db.user.update({ where: { id: setup.user.id }, data: { passwordHash } }),
      this.db.session.updateMany({
        where: { userId: setup.user.id, revokedAt: null },
        data: { revokedAt: now },
      }),
    ]);
    this.log.log(`account ${setup.user.id} set its own password`);
  }

  /** Asks for the password in hand: a session somebody else is holding must
   *  not be able to shut the owner out of their own account (KEHOACH 9.4).
   */
  async changePassword(userId: string, current: string, next: string): Promise<void> {
    const user = await this.db.user.findUnique({ where: { id: userId } });
    if (!user || !user.active || !(await verifyPassword(current, user.passwordHash))) {
      throw new UnauthorizedException("CREDENTIALS_REJECTED");
    }
    const passwordHash = await hashPassword(next);
    const now = new Date();
    await this.db.$transaction([
      this.db.user.update({ where: { id: userId }, data: { passwordHash } }),
      this.db.session.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: now },
      }),
    ]);
    this.log.log(`account ${userId} changed its own password`);
  }

  /** Answers the same for an address with an account and one without, so the
   *  door cannot be read as a list of who works here (KEHOACH 9.4).
   */
  async forgot(email: string): Promise<void> {
    const user = await this.db.user.findUnique({
      where: { email },
      select: { id: true, active: true, employee: { select: { locale: true } } },
    });
    if (!user || !user.active) {
      this.log.log("a setup link was asked for by an address with no account");
      return;
    }
    const link = randomBytes(LINK_BYTES).toString("base64url");
    const expiresAt = new Date(
      Date.now() + this.config.get("PASSWORD_SETUP_TTL_HOURS", { infer: true }) * UNIT_MS.h,
    );
    await this.db.passwordSetup.create({
      data: { userId: user.id, tokenHash: fingerprint(link), expiresAt },
    });
    const root = this.config.get("APP_PUBLIC_URL", { infer: true });
    await this.queues[QUEUE.notify].add("password-setup", {
      type: "password-setup",
      userId: user.id,
      link: `${root}/${user.employee?.locale ?? DEFAULT_MAIL_LOCALE}/set-password?token=${link}`,
      reason: "forgot",
    } satisfies PasswordSetupJob);
  }

  /** Sign one device out, leaving the rest of them signed in. */
  async close(sessionId: string): Promise<void> {
    await this.db.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Sign every device out at once: leaving, or a password nobody else knows. */
  async closeAll(userId: string): Promise<void> {
    await this.db.session.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Sign a kiosk token; a jti keeps two issued within one second apart (KEHOACH 7.3). */
  signDevice(claims: DeviceClaims): string {
    const days = this.config.get("DEVICE_TOKEN_TTL_DAYS", { infer: true });
    return this.jwt.sign(claims, {
      secret: this.config.get("JWT_DEVICE_SECRET", { infer: true }),
      expiresIn: `${days}d`,
      jwtid: randomUUID(),
    });
  }

  /** Whether a kiosk ticket still stands: live, this device's, approved, and
   *  either the ticket on the row or, mid-renewal, the one it replaced. The first
   *  use of the new ticket retires the old one (KEHOACH 7.3, 7.4).
   */
  async admitDevice(deviceId: string, token: string): Promise<boolean> {
    let claims: DeviceClaims;
    try {
      claims = this.jwt.verify<DeviceClaims>(token, {
        secret: this.config.get("JWT_DEVICE_SECRET", { infer: true }),
      });
    } catch {
      return false;
    }
    if (claims.deviceId !== deviceId) {
      return false;
    }
    const held = await this.db.device.findUnique({
      where: { id: deviceId },
      select: { status: true, tokenHash: true, prevTokenHash: true },
    });
    if (held?.status !== "APPROVED" || held.tokenHash === null) {
      return false;
    }
    const given = deviceFingerprint(token);
    if (!sameFingerprint(given, held.tokenHash)) {
      return sameFingerprint(given, held.prevTokenHash);
    }
    if (held.prevTokenHash !== null) {
      await this.db.device.updateMany({
        where: { id: deviceId, tokenHash: held.tokenHash },
        data: { prevTokenHash: null },
      });
    }
    return true;
  }

  /** Drop what a login would otherwise pile up: spent rows, then the oldest
   *  device once this account holds as many as it is allowed (KEHOACH 9.23).
   */
  private async makeRoom(userId: string): Promise<void> {
    const now = new Date();
    await this.db.session.deleteMany({
      where: { userId, OR: [{ expiresAt: { lte: now } }, { revokedAt: { not: null } }] },
    });
    const cap = this.config.get("SESSIONS_PER_USER", { infer: true });
    const spare = await this.db.session.findMany({
      where: { userId, revokedAt: null, expiresAt: { gt: now } },
      orderBy: { lastSeenAt: "desc" },
      select: { id: true },
      skip: cap - 1,
    });
    if (spare.length > 0) {
      await this.db.session.deleteMany({ where: { id: { in: spare.map((one) => one.id) } } });
    }
  }

  private async issue(
    user: User,
    sessionId: string | null,
    from: SignedInFrom,
  ): Promise<IssuedTokens> {
    const jti = randomUUID();
    const tokenHash = fingerprint(jti);
    const expiresAt = new Date(
      Date.now() + ttlToMs(this.config.get("JWT_REFRESH_TTL", { infer: true })),
    );
    const session =
      sessionId === null
        ? await this.db.session.create({
            data: {
              userId: user.id,
              tokenHash,
              expiresAt,
              userAgent: from.userAgent ?? null,
              ip: from.ip ?? null,
            },
            select: { id: true },
          })
        : await this.db.session.update({
            where: { id: sessionId },
            data: { tokenHash, expiresAt, lastSeenAt: new Date() },
            select: { id: true },
          });
    const access: AccessClaims = {
      sub: user.id,
      role: user.role,
      sid: session.id,
      ...(user.employeeId !== null ? { employeeId: user.employeeId } : {}),
    };
    const refresh: RefreshClaims = { sub: user.id, sid: session.id, jti };
    const accessToken = this.jwt.sign(access, {
      secret: this.config.get("JWT_ACCESS_SECRET", { infer: true }),
      expiresIn: this.config.get("JWT_ACCESS_TTL", { infer: true }),
    });
    const refreshToken = this.jwt.sign(refresh, {
      secret: this.config.get("JWT_REFRESH_SECRET", { infer: true }),
      expiresIn: this.config.get("JWT_REFRESH_TTL", { infer: true }),
    });
    return { accessToken, refreshToken };
  }
}

function fingerprint(jti: string): string {
  return createHash("sha256").update(jti).digest("hex");
}
