import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import type { Role, User } from "@prisma/client";

import { ConfigService } from "@nestjs/config";

import { QUEUE_TOKEN, type Queues } from "../../queue/queue.module.js";
import { QUEUE, type PasswordSetupJob, type SetupReason } from "../../queue/queues.js";

import type { Env } from "../../config/env.schema.js";
import type { Page, PaginationDto } from "../../common/dto/pagination.dto.js";
import { PrismaService } from "../../database/prisma.service.js";

import { AUDIT_ACTIONS, AUDIT_SUBJECTS } from "../audit/audit-actions.js";
import { AuditService } from "../audit/audit.service.js";
import { LINK_BYTES, UNUSABLE_PASSWORD } from "../auth/password.js";
import { DEFAULT_MAIL_LOCALE } from "../payroll/mail-text.js";
import type { CreateUserDto, UpdateUserDto } from "./dto/user.dto.js";

const UNIQUE_VIOLATION = "P2002";
const HOUR_MS = 3_600_000;

function fingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A user as an api may show one: no hash, no refresh fingerprint. */
export type PublicUser = Pick<User, "id" | "email" | "role" | "createdAt" | "updatedAt">;

const VISIBLE = {
  id: true,
  email: true,
  role: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** Who got an invitation. No secret here: the link goes to them, not here. */
export type LoginOpened =
  | { userId: string; skipped?: undefined }
  | { userId?: undefined; skipped: "LOGIN_EXISTS" | "NO_EMAIL" | "EMAIL_TAKEN" };

export interface ProvisionedAccount {
  employeeCode: string;
  email: string;
  role: string;
}

/** `waiting` is how many people this call left for the next one (KEHOACH 9.4). */
export interface Provisioning {
  accounts: ProvisionedAccount[];
  waiting: number;
}

@Injectable()
export class UsersService {
  private readonly log = new Logger(UsersService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly audit: AuditService,
    private readonly config: ConfigService<Env, true>,
    @Inject(QUEUE_TOKEN) private readonly queues: Queues,
  ) {}


  /** Open a login for every active employee who has an address and none yet.
   *  Whoever has people reporting to them starts as MANAGER, so the approval
   *  inbox is not empty on day one (KEHOACH 9.4).
   */
  async provision(): Promise<Provisioning> {
    const unopened = { active: true, login: null, personalEmail: { not: null } } as const;
    const batch = this.config.get("PROVISION_BATCH", { infer: true });
    const waiting = await this.db.employee.findMany({
      where: unopened,
      select: {
        id: true,
        code: true,
        personalEmail: true,
        locale: true,
        _count: { select: { reports: true } },
      },
      orderBy: { code: "asc" },
      take: batch,
    });
    const invites = waiting.map((person) => ({
      userId: randomUUID(),
      link: randomBytes(LINK_BYTES).toString("base64url"),
      person,
    }));
    const expiresAt = new Date(
      Date.now() + this.config.get("PASSWORD_SETUP_TTL_HOURS", { infer: true }) * HOUR_MS,
    );
    // Both statements or neither: an account with no link is one nobody can
    // reach, and a link with no account points at nothing.
    await this.db.$transaction(async (tx) => {
      await tx.user.createMany({
        data: invites.map((one) => ({
          id: one.userId,
          email: one.person.personalEmail as string,
          passwordHash: UNUSABLE_PASSWORD,
          role: one.person._count.reports > 0 ? "MANAGER" : "EMPLOYEE",
          employeeId: one.person.id,
        })),
        skipDuplicates: true,
      });
      // An address another login already holds gets skipped above, so the
      // links follow the rows that landed, not the ones on offer.
      const born = await tx.user.findMany({
        where: { id: { in: invites.map((one) => one.userId) } },
        select: { id: true },
      });
      const kept = new Set(born.map((one) => one.id));
      await tx.passwordSetup.createMany({
        data: invites
          .filter((one) => kept.has(one.userId))
          .map((one) => ({ userId: one.userId, tokenHash: fingerprint(one.link), expiresAt })),
        skipDuplicates: true,
      });
    });
    const opened = await this.db.user.findMany({
      where: { id: { in: invites.map((one) => one.userId) } },
      select: { id: true },
    });
    const landed = new Set(opened.map((one) => one.id));
    const root = this.config.get("APP_PUBLIC_URL", { infer: true });
    for (const one of invites.filter((each) => landed.has(each.userId))) {
      await this.queues[QUEUE.notify].add("password-setup", {
        type: "password-setup",
        userId: one.userId,
        link: `${root}/${one.person.locale}/set-password?token=${one.link}`,
        reason: "opened",
      } satisfies PasswordSetupJob);
    }
    const left = await this.db.employee.count({ where: unopened });
    this.log.log(`invited ${landed.size} employee(s), ${left} still waiting`);
    return {
      accounts: invites
        .filter((one) => landed.has(one.userId))
        .map((one) => ({
          employeeCode: one.person.code,
          email: one.person.personalEmail as string,
          role: one.person._count.reports > 0 ? "MANAGER" : "EMPLOYEE",
        })),
      waiting: left,
    };
  }

  async list(query: PaginationDto): Promise<Page<PublicUser>> {
    const [rows, total] = await Promise.all([
      this.db.user.findMany({
        select: VISIBLE,
        skip: query.skip,
        take: query.take,
        orderBy: { email: "asc" },
      }),
      this.db.user.count(),
    ]);
    return { rows, total };
  }

  /** Mints a one-time link and mails it. Nobody but the holder ever knows the
   *  password, which is the same rule the bulk opening follows (KEHOACH 9.4).
   */
  private async sendSetup(userId: string, locale: string, why: SetupReason): Promise<void> {
    const link = randomBytes(LINK_BYTES).toString("base64url");
    const expiresAt = new Date(
      Date.now() + this.config.get("PASSWORD_SETUP_TTL_HOURS", { infer: true }) * HOUR_MS,
    );
    await this.db.passwordSetup.create({
      data: { userId, tokenHash: fingerprint(link), expiresAt },
    });
    const root = this.config.get("APP_PUBLIC_URL", { infer: true });
    await this.queues[QUEUE.notify].add("password-setup", {
      type: "password-setup",
      userId,
      link: `${root}/${locale}/set-password?token=${link}`,
      reason: why,
    } satisfies PasswordSetupJob);
  }

  /** Open the login a hire needs, saying why when it opens none. The role is
   *  read off the org tree, the same way a bulk run reads it (KEHOACH 9.14).
   */
  async openFor(employeeId: number): Promise<LoginOpened> {
    const person = await this.db.employee.findUnique({
      where: { id: employeeId },
      select: {
        id: true,
        personalEmail: true,
        locale: true,
        login: { select: { id: true } },
        _count: { select: { reports: true } },
      },
    });
    if (person?.login) {
      return { skipped: "LOGIN_EXISTS" };
    }
    if (!person?.personalEmail) {
      return { skipped: "NO_EMAIL" };
    }
    try {
      const made = await this.db.user.create({
        data: {
          email: person.personalEmail,
          passwordHash: UNUSABLE_PASSWORD,
          role: person._count.reports > 0 ? "MANAGER" : "EMPLOYEE",
          employeeId: person.id,
        },
        select: { id: true },
      });
      await this.sendSetup(made.id, person.locale, "opened");
      return { userId: made.id };
    } catch (error) {
      if (isCode(error, UNIQUE_VIOLATION)) {
        return { skipped: "EMAIL_TAKEN" };
      }
      throw error;
    }
  }

  /** Sends the link again, which is how a forgotten password is recovered
   *  without anybody else ever holding one.
   */
  async invite(actorId: string, id: string): Promise<void> {
    const held = await this.db.user.findUnique({
      where: { id },
      select: { id: true, active: true, employee: { select: { locale: true } } },
    });
    if (!held || !held.active) {
      throw new NotFoundException("USER_NOT_FOUND");
    }
    await this.sendSetup(held.id, held.employee?.locale ?? DEFAULT_MAIL_LOCALE, "forgot");
    await this.audit.record({
      actorId,
      action: AUDIT_ACTIONS.USER_INVITE,
      subject: AUDIT_SUBJECTS.USER,
      subjectId: id,
    });
  }

  async create(actorId: string, body: CreateUserDto): Promise<PublicUser> {
    try {
      const made = await this.db.user.create({
        data: {
          email: body.email,
          role: body.role as Role,
          passwordHash: UNUSABLE_PASSWORD,
        },
        select: VISIBLE,
      });
      await this.sendSetup(made.id, DEFAULT_MAIL_LOCALE, "opened");
      await this.audit.record({
        actorId,
        action: AUDIT_ACTIONS.USER_CREATE,
        subject: AUDIT_SUBJECTS.USER,
        subjectId: made.id,
        meta: { email: made.email, role: made.role },
      });
      return made;
    } catch (error) {
      if (isCode(error, UNIQUE_VIOLATION)) {
        throw new ConflictException(`${body.email} already has an account`);
      }
      throw error;
    }
  }

  async update(actorId: string, id: string, body: UpdateUserDto): Promise<PublicUser> {
    const held = await this.get(id);
    const saved = await this.db.user.update({
      where: { id },
      data: {
        ...(body.email ? { email: body.email } : {}),
        ...(body.role ? { role: body.role as Role } : {}),
      },
      select: VISIBLE,
    });
    if (body.role && body.role !== held.role) {
      await this.audit.record({
        actorId,
        action: AUDIT_ACTIONS.USER_ROLE,
        subject: AUDIT_SUBJECTS.USER,
        subjectId: id,
        meta: { from: held.role, to: body.role },
      });
    }
    return saved;
  }

  /** Remove an account, unless it is the last one that can manage accounts. */
  async remove(id: string, actorId: string): Promise<void> {
    if (id === actorId) {
      throw new BadRequestException("CANNOT_DELETE_SELF");
    }
    const target = await this.get(id);
    if (target.role === "ADMIN") {
      const admins = await this.db.user.count({ where: { role: "ADMIN" } });
      if (admins <= 1) {
        throw new BadRequestException("LAST_ADMIN");
      }
    }
    await this.db.user.delete({ where: { id } });
    await this.audit.record({
      actorId,
      action: AUDIT_ACTIONS.USER_DELETE,
      subject: AUDIT_SUBJECTS.USER,
      subjectId: id,
      meta: { email: target.email, role: target.role },
    });
  }

  private async get(id: string): Promise<PublicUser> {
    const found = await this.db.user.findUnique({ where: { id }, select: VISIBLE });
    if (!found) {
      throw new NotFoundException(`no user ${id}`);
    }
    return found;
  }
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
