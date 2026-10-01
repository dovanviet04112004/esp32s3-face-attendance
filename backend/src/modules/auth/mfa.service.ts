import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  randomUUID,
} from "node:crypto";

import { ConflictException, Inject, Injectable, Logger, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import { ThrottlerException } from "@nestjs/throttler";
import type { Role } from "@prisma/client";

import type { Env } from "../../config/env.schema.js";
import { PrismaService } from "../../database/prisma.service.js";
import { QUEUE_TOKEN, type Queues } from "../../queue/queue.module.js";
import { JOB, QUEUE, type MfaChange, type MfaChangedJob } from "../../queue/queues.js";
import { AUDIT_ACTIONS, AUDIT_SUBJECTS } from "../audit/audit-actions.js";
import { AuditService } from "../audit/audit.service.js";
import { JWT_ALGORITHM, type AccessClaims } from "./auth.types.js";
import { base32, newBackupCodes, newSecret, otpauthUri, readCode, stepOf } from "./totp.js";

const SEAL_ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const SUBKEY_BYTES = 32;
const CHALLENGE_TYPE = "mfa";
const MS_PER_MINUTE = 60_000;

type Purpose = "seal" | "backup" | "challenge";

type Keys = Record<Purpose, Buffer>;

interface ChallengeClaims {
  sub: string;
  typ: string;
}

/** What a right password earns an account that signs in with a code (KEHOACH 9.4). */
export interface PendingCode {
  step: "code" | "enroll";
  challenge: string;
  expiresInSeconds: number;
}

/** A secret on offer, as the authenticator reads it off the QR or by hand. */
export interface OfferedSecret {
  secret: string;
  uri: string;
}

export interface Enrolled {
  userId: string;
  backupCodes: string[];
}

export interface MfaStatus {
  required: boolean;
  enabledAt: Date | null;
  backupCodesLeft: number;
}

function subkeys(master: string | undefined): Keys | null {
  if (master === undefined) {
    return null;
  }
  const key = Buffer.from(master, "base64");
  const derive = (purpose: Purpose) =>
    Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), `kiosk-mfa:${purpose}`, SUBKEY_BYTES));
  return { seal: derive("seal"), backup: derive("backup"), challenge: derive("challenge") };
}

/** Two-step sign-in for the roles MFA_ROLES names (KEHOACH 9.4). */
@Injectable()
export class MfaService {
  private readonly log = new Logger(MfaService.name);
  private readonly roles: ReadonlySet<Role>;
  private readonly keys: Keys | null;
  private readonly issuer: string;

  constructor(
    private readonly db: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
    private readonly audit: AuditService,
    @Inject(QUEUE_TOKEN) private readonly queues: Queues,
  ) {
    this.roles = new Set(config.get("MFA_ROLES", { infer: true }));
    this.keys = subkeys(config.get("MFA_KEY", { infer: true }));
    this.issuer = new URL(config.get("APP_PUBLIC_URL", { infer: true })).host;
  }

  required(role: Role): boolean {
    return this.roles.has(role);
  }

  /** Whether an access token lacks the second factor its role asks for. */
  missing(claims: Pick<AccessClaims, "role" | "mfa">): boolean {
    return this.required(claims.role) && claims.mfa !== true;
  }

  async challenge(userId: string): Promise<PendingCode> {
    const held = await this.db.userMfa.findUnique({ where: { userId }, select: { secret: true } });
    const challenge = this.jwt.sign({ typ: CHALLENGE_TYPE } satisfies Omit<ChallengeClaims, "sub">, {
      secret: this.need().challenge,
      subject: userId,
      expiresIn: `${this.config.get("MFA_CHALLENGE_MINUTES", { infer: true })}m`,
      jwtid: randomUUID(),
    });
    return { step: held?.secret ? "code" : "enroll", challenge, expiresInSeconds: this.challengeMs() / 1000 };
  }

  /** Offer a fresh secret to the account a ticket names, while it has none. */
  async setup(challenge: string): Promise<OfferedSecret> {
    const userId = this.holderOf(challenge);
    const account = await this.account(userId);
    const held = await this.db.userMfa.findUnique({ where: { userId }, select: { secret: true } });
    if (held?.secret) {
      throw new ConflictException("MFA_ALREADY_ON");
    }
    const secret = newSecret();
    const offer = { pendingSecret: this.seal(secret, userId), pendingAt: new Date() };
    await this.db.userMfa.upsert({ where: { userId }, create: { userId, ...offer }, update: offer });
    return { secret: base32(secret), uri: otpauthUri(this.issuer, account.email, secret) };
  }

  /** Keep the offered secret once its first code checks; the backup codes leave the server here, once. */
  async confirm(challenge: string, code: string): Promise<Enrolled> {
    const userId = this.holderOf(challenge);
    await this.account(userId);
    const held = await this.db.userMfa.findUnique({ where: { userId } });
    if (held?.secret) {
      throw new ConflictException("MFA_ALREADY_ON");
    }
    if (!held?.pendingSecret || !held.pendingAt || held.pendingAt.getTime() <= Date.now() - this.challengeMs()) {
      throw new UnauthorizedException("MFA_CHALLENGE_SPENT");
    }
    const armed = await this.reserve(userId);
    const typed = readCode(code);
    const step = typed?.kind === "totp" ? stepOf(this.open(held.pendingSecret, userId), typed.code, Date.now()) : null;
    if (step === null) {
      return this.refuse(userId, armed);
    }
    const backupCodes = newBackupCodes();
    const kept = await this.db.userMfa.updateMany({
      where: { userId, secret: null, pendingAt: held.pendingAt },
      data: {
        secret: held.pendingSecret,
        pendingSecret: null,
        pendingAt: null,
        enabledAt: new Date(),
        lastStep: step,
        backupCodes: backupCodes.map((one) => this.backupHash(userId, one)),
        misses: 0,
        lockedUntil: null,
      },
    });
    if (kept.count === 0) {
      throw new ConflictException("MFA_ALREADY_ON");
    }
    await this.audit.record({ actorId: userId, action: AUDIT_ACTIONS.USER_MFA_ON, subject: AUDIT_SUBJECTS.USER, subjectId: userId });
    await this.tell(userId, "on");
    return { userId, backupCodes };
  }

  /** The account a ticket names, once its code checks: six digits or one backup code. */
  async verify(challenge: string, code: string): Promise<string> {
    const userId = this.holderOf(challenge);
    await this.account(userId);
    const held = await this.db.userMfa.findUnique({ where: { userId }, select: { secret: true } });
    // Reset while the ticket waited: back to the password, which leads to enrolment.
    if (!held?.secret) {
      throw new UnauthorizedException("MFA_CHALLENGE_SPENT");
    }
    await this.check(userId, held.secret, code);
    return userId;
  }

  /** A new set of backup codes for an account that gives a working code; the old set stops working. */
  async renewCodes(userId: string, code: string): Promise<string[]> {
    const held = await this.db.userMfa.findUnique({ where: { userId }, select: { secret: true } });
    if (!held?.secret || this.keys === null) {
      throw new ConflictException("MFA_NOT_ON");
    }
    await this.check(userId, held.secret, code);
    const backupCodes = newBackupCodes();
    await this.db.userMfa.update({
      where: { userId },
      data: { backupCodes: backupCodes.map((one) => this.backupHash(userId, one)) },
    });
    await this.audit.record({ actorId: userId, action: AUDIT_ACTIONS.USER_MFA_CODES, subject: AUDIT_SUBJECTS.USER, subjectId: userId });
    return backupCodes;
  }

  async status(userId: string, role: Role): Promise<MfaStatus> {
    const held = await this.db.userMfa.findUnique({
      where: { userId },
      select: { secret: true, enabledAt: true, backupCodes: true },
    });
    const on = Boolean(held?.secret);
    return {
      required: this.required(role),
      enabledAt: on ? (held?.enabledAt ?? null) : null,
      backupCodesLeft: on ? (held?.backupCodes.length ?? 0) : 0,
    };
  }

  /** Drop an account's authenticator, codes and misses, and tell its owner; false when it had none. */
  async reset(actorId: string | null, userId: string): Promise<boolean> {
    const held = await this.db.userMfa.findUnique({ where: { userId }, select: { secret: true } });
    await this.db.userMfa.deleteMany({ where: { userId } });
    if (!held?.secret) {
      return false;
    }
    await this.audit.record({
      ...(actorId === null ? {} : { actorId }),
      action: AUDIT_ACTIONS.USER_MFA_RESET,
      subject: AUDIT_SUBJECTS.USER,
      subjectId: userId,
    });
    await this.tell(userId, "reset");
    return true;
  }

  private async check(userId: string, sealed: Uint8Array, code: string): Promise<void> {
    const armed = await this.reserve(userId);
    const typed = readCode(code);
    if (typed?.kind === "totp") {
      const step = stepOf(this.open(sealed, userId), typed.code, Date.now());
      if (step !== null && (await this.advance(userId, step))) {
        return;
      }
    } else if (typed?.kind === "backup") {
      const left = await this.spend(userId, typed.code);
      if (left !== null) {
        await this.audit.record({
          actorId: userId,
          action: AUDIT_ACTIONS.USER_MFA_BACKUP,
          subject: AUDIT_SUBJECTS.USER,
          subjectId: userId,
          meta: { left },
        });
        await this.tell(userId, "backup", left);
        return;
      }
    }
    await this.refuse(userId, armed);
  }

  // Taken ahead of reading the code, so parallel guesses cannot outrun the lock; the last one arms it (KEHOACH 9.4 rule 6).
  private async reserve(userId: string): Promise<boolean> {
    const after = this.config.get("MFA_LOCK_AFTER", { infer: true });
    const minutes = this.config.get("MFA_LOCK_MINUTES", { infer: true });
    const taken = await this.db.$queryRaw<{ armed: boolean }[]>`
      UPDATE "UserMfa" SET
        "misses" = CASE WHEN "lockedUntil" IS NULL THEN "misses" ELSE 0 END + 1,
        "lockedUntil" = CASE WHEN (CASE WHEN "lockedUntil" IS NULL THEN "misses" ELSE 0 END) + 1 >= ${after}::int
          THEN now() + make_interval(mins => ${minutes}::int) ELSE NULL END
      WHERE "userId" = ${userId} AND ("lockedUntil" IS NULL OR "lockedUntil" <= now())
      RETURNING "lockedUntil" IS NOT NULL AS "armed"`;
    if (taken.length === 0) {
      throw new ThrottlerException("MFA_LOCKED");
    }
    return taken[0].armed;
  }

  private async refuse(userId: string, armed: boolean): Promise<never> {
    if (armed) {
      const minutes = this.config.get("MFA_LOCK_MINUTES", { infer: true });
      await this.audit.record({ action: AUDIT_ACTIONS.USER_MFA_LOCKED, subject: AUDIT_SUBJECTS.USER, subjectId: userId, meta: { minutes } });
      await this.tell(userId, "locked");
      this.log.warn(`account ${userId} gave the right password and wrong codes; its code step is locked`);
    }
    throw new UnauthorizedException("MFA_CODE_REJECTED");
  }

  // The compare sits in the UPDATE that advances, so two logins racing one code cannot both pass (KEHOACH 9.4 rule 4).
  private async advance(userId: string, step: number): Promise<boolean> {
    const moved = await this.db.$executeRaw`
      UPDATE "UserMfa" SET "lastStep" = ${step}::int, "misses" = 0, "lockedUntil" = NULL
      WHERE "userId" = ${userId} AND ("lastStep" IS NULL OR "lastStep" < ${step}::int)`;
    return moved === 1;
  }

  private async spend(userId: string, code: string): Promise<number | null> {
    const hash = this.backupHash(userId, code);
    const spent = await this.db.$queryRaw<{ left: number }[]>`
      UPDATE "UserMfa" SET "backupCodes" = array_remove("backupCodes", ${hash}), "misses" = 0, "lockedUntil" = NULL
      WHERE "userId" = ${userId} AND ${hash} = ANY("backupCodes")
      RETURNING coalesce(cardinality("backupCodes"), 0)::int AS "left"`;
    return spent.length === 1 ? spent[0].left : null;
  }

  private async account(userId: string): Promise<{ email: string }> {
    const user = await this.db.user.findUnique({ where: { id: userId }, select: { email: true, active: true, role: true } });
    if (!user?.active || !this.required(user.role)) {
      throw new UnauthorizedException("MFA_CHALLENGE_SPENT");
    }
    return user;
  }

  private holderOf(challenge: string): string {
    if (this.keys !== null) {
      try {
        const claims = this.jwt.verify<ChallengeClaims>(challenge, {
          secret: this.keys.challenge,
          algorithms: [JWT_ALGORITHM],
        });
        if (claims.typ === CHALLENGE_TYPE && typeof claims.sub === "string") {
          return claims.sub;
        }
      } catch {
        // Forged, expired or signed under another key: all three restart at the password.
      }
    }
    throw new UnauthorizedException("MFA_CHALLENGE_SPENT");
  }

  private backupHash(userId: string, code: string): string {
    return createHmac("sha256", this.need().backup).update(`${userId}:${code.replace("-", "")}`).digest("hex");
  }

  // The user id is the associated data, so a sealed secret copied onto another row fails to open (KEHOACH 9.4 rule 3).
  private seal(plain: Buffer, userId: string): Uint8Array<ArrayBuffer> {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(SEAL_ALGORITHM, this.need().seal, iv);
    cipher.setAAD(Buffer.from(userId));
    const body = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Uint8Array.from(Buffer.concat([iv, cipher.getAuthTag(), body]));
  }

  private open(sealed: Uint8Array, userId: string): Buffer {
    const held = Buffer.from(sealed);
    const decipher = createDecipheriv(SEAL_ALGORITHM, this.need().seal, held.subarray(0, IV_BYTES));
    decipher.setAAD(Buffer.from(userId));
    decipher.setAuthTag(held.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(held.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
  }

  private need(): Keys {
    if (this.keys === null) {
      throw new Error("MFA_KEY is not set");
    }
    return this.keys;
  }

  private challengeMs(): number {
    return this.config.get("MFA_CHALLENGE_MINUTES", { infer: true }) * MS_PER_MINUTE;
  }

  private async tell(userId: string, change: MfaChange, backupCodesLeft?: number): Promise<void> {
    await this.queues[QUEUE.notify].add(JOB.mfaChanged, {
      type: JOB.mfaChanged,
      userId,
      change,
      ...(backupCodesLeft === undefined ? {} : { backupCodesLeft }),
    } satisfies MfaChangedJob);
  }
}
