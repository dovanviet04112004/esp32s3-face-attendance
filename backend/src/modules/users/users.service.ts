import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { Role, type Prisma } from "@prisma/client";

import { ConfigService } from "@nestjs/config";

import { QUEUE_TOKEN, type Queues } from "../../queue/queue.module.js";
import { JOB, QUEUE, type PasswordSetupJob, type SetupReason } from "../../queue/queues.js";

import type { Env } from "../../config/env.schema.js";
import { COUNT_CEILING, countedTo, decodeCursor, nextCursor } from "../../common/dto/cursor.dto.js";
import type { Page } from "../../common/dto/pagination.dto.js";
import { PrismaService } from "../../database/prisma.service.js";

import { AUDIT_ACTIONS, AUDIT_SUBJECTS } from "../audit/audit-actions.js";
import { AuditService } from "../audit/audit.service.js";
import { AuthService } from "../auth/auth.service.js";
import { LINK_BYTES, UNUSABLE_PASSWORD } from "../auth/password.js";
import { departmentSubtree } from "../../common/scope/department-subtree.js";
import { DEFAULT_MAIL_LOCALE } from "../payroll/mail-text.js";
import type {
  AccountCounts,
  AccountStatus,
  AccountView,
  CreateUserDto,
  ListUsersDto,
  LoginOpenedView,
  LoginStateView,
  MeView,
  UpdateUserDto,
  UserFilterDto,
} from "./dto/user.dto.js";

const UNIQUE_VIOLATION = "P2002";
const HOUR_MS = 3_600_000;

// Roles that read or decide as one particular person in the company (KEHOACH 9.4).
const NEEDS_EMPLOYEE: ReadonlySet<Role> = new Set<Role>(["EMPLOYEE", "MANAGER", "PAYROLL"]);
const TREE_ROLES: ReadonlySet<Role> = new Set<Role>(["EMPLOYEE", "MANAGER"]);

function fingerprint(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

const PERSON = {
  id: true,
  code: true,
  fullName: true,
  department: { select: { id: true, name: true } },
} as const satisfies Prisma.EmployeeSelect;

// The hash is read only to tell a pending account apart; asAccount drops it.
const ACCOUNT = {
  id: true,
  email: true,
  role: true,
  active: true,
  passwordHash: true,
  createdAt: true,
  employeeId: true,
  employee: { select: PERSON },
} as const satisfies Prisma.UserSelect;

type AccountRow = Prisma.UserGetPayload<{ select: typeof ACCOUNT }>;

function asAccount(row: AccountRow, lastSeenAt: Date | null): AccountView {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    active: row.active,
    pending: row.passwordHash === UNUSABLE_PASSWORD,
    lastSeenAt,
    createdAt: row.createdAt,
    employee: row.employee,
  };
}

/** The accounts in one status, as the users page and the directory's account filter both read it. */
export function statusWhere(status: AccountStatus): Prisma.UserWhereInput {
  if (status === "locked") {
    return { active: false };
  }
  return status === "pending"
    ? { active: true, passwordHash: UNUSABLE_PASSWORD }
    : { active: true, passwordHash: { not: UNUSABLE_PASSWORD } };
}

/** The filters of a list, minus the one a facet count leaves out so it can count its own values. */
function accountWhere(
  query: UserFilterDto,
  branch: string[] | null,
  facet?: "role" | "status",
): Prisma.UserWhereInput {
  const parts: Prisma.UserWhereInput[] = [];
  if (query.role && facet !== "role") {
    parts.push({ role: query.role });
  }
  if (query.status && facet !== "status") {
    parts.push(statusWhere(query.status));
  }
  if (branch) {
    parts.push({ employee: { departmentId: { in: branch } } });
  }
  if (query.search) {
    const term = { contains: query.search, mode: "insensitive" as const };
    parts.push({ OR: [{ email: term }, { employee: { code: term } }, { employee: { fullName: term } }] });
  }
  return { AND: parts };
}

/** One account the org tree moved between EMPLOYEE and MANAGER (KEHOACH 9.4). */
export interface RoleFlip {
  userId: string;
  from: Role;
  to: Role;
}

interface Linkable {
  id: number;
  locale: string;
  active: boolean;
  login: { id: string } | null;
  _count: { reports: number };
}

const LINKABLE = {
  id: true,
  locale: true,
  active: true,
  login: { select: { id: true } },
  _count: { select: { reports: { where: { active: true } } } },
} as const satisfies Prisma.EmployeeSelect;

// A scheduled last day still works; only a closed record has left (KEHOACH 9.14).
function hasLeft(person: { active: boolean }): boolean {
  return !person.active;
}

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
    private readonly auth: AuthService,
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
        _count: { select: { reports: { where: { active: true } } } },
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
      const asked = invites.map((one) => one.person.id);
      // Held under a share lock for the insert: somebody offboarded between
      // the list above and this key breaks it, and the batch opens nothing.
      const standing = await tx.$queryRaw<{ id: number }[]>`
        SELECT "id" FROM "Employee" WHERE "id" = ANY(${asked}::int[]) FOR SHARE
      `;
      const here = new Set(standing.map((one) => one.id));
      await tx.user.createMany({
        data: invites
          .filter((one) => here.has(one.person.id))
          .map((one) => ({
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
      await this.queues[QUEUE.notify].add(JOB.passwordSetup, {
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

  async list(query: ListUsersDto): Promise<Page<AccountView>> {
    const branch = query.departmentId ? await departmentSubtree(this.db, query.departmentId) : null;
    const where = accountWhere(query, branch);
    const from = query.cursor ? decodeCursor(query.cursor) : null;
    const resumed: Prisma.UserWhereInput = from
      ? {
          AND: [
            where,
            { OR: [{ email: { gt: from.sortValue } }, { email: from.sortValue, id: { gt: from.id } }] },
          ],
        }
      : where;
    const [rows, found] = await Promise.all([
      this.db.user.findMany({
        where: resumed,
        select: ACCOUNT,
        skip: from ? 0 : query.skip,
        take: query.take,
        orderBy: [{ email: "asc" }, { id: "asc" }],
      }),
      this.db.user.count({ where, take: COUNT_CEILING + 1 }),
    ]);
    const seen = await this.lastSeen(rows.map((row) => row.id));
    return {
      rows: rows.map((row) => asAccount(row, seen.get(row.id) ?? null)),
      ...countedTo(found),
      next: nextCursor(rows, query.take, (row) => row.email),
    };
  }

  /** How many accounts each role and each status holds under the other filters. */
  async counts(query: UserFilterDto): Promise<AccountCounts> {
    const branch = query.departmentId ? await departmentSubtree(this.db, query.departmentId) : null;
    const forRoles = accountWhere(query, branch, "role");
    const forStatus = accountWhere(query, branch, "status");
    const [roles, active, locked, pending] = await Promise.all([
      this.db.user.groupBy({ by: ["role"], where: forRoles, _count: { _all: true } }),
      this.db.user.count({ where: { AND: [forStatus, statusWhere("active")] } }),
      this.db.user.count({ where: { AND: [forStatus, statusWhere("locked")] } }),
      this.db.user.count({ where: { AND: [forStatus, statusWhere("pending")] } }),
    ]);
    const byRole = Object.fromEntries(Object.values(Role).map((role) => [role, 0])) as Record<Role, number>;
    for (const one of roles) {
      byRole[one.role] = one._count._all;
    }
    return { byRole, byStatus: { active, locked, pending } };
  }

  /** The signed-in account as its own menu shows it. */
  async me(userId: string): Promise<MeView> {
    const found = await this.db.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, role: true, employee: { select: PERSON } },
    });
    if (!found) {
      throw new NotFoundException("USER_NOT_FOUND");
    }
    return found;
  }

  // A session row is stamped at sign-in and at every renewal, so its latest stamp is the last visit.
  private async lastSeen(userIds: string[]): Promise<Map<string, Date>> {
    if (userIds.length === 0) {
      return new Map();
    }
    const rows = await this.db.session.groupBy({
      by: ["userId"],
      where: { userId: { in: userIds } },
      _max: { lastSeenAt: true },
    });
    const seen = new Map<string, Date>();
    for (const row of rows) {
      if (row._max.lastSeenAt) {
        seen.set(row.userId, row._max.lastSeenAt);
      }
    }
    return seen;
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
    await this.queues[QUEUE.notify].add(JOB.passwordSetup, {
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
        _count: { select: { reports: { where: { active: true } } } },
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
      select: { id: true, active: true, passwordHash: true, employee: { select: { locale: true } } },
    });
    if (!held || !held.active) {
      throw new NotFoundException("USER_NOT_FOUND");
    }
    const why: SetupReason = held.passwordHash === UNUSABLE_PASSWORD ? "opened" : "forgot";
    await this.sendSetup(held.id, held.employee?.locale ?? DEFAULT_MAIL_LOCALE, why);
    await this.audit.record({
      actorId,
      action: AUDIT_ACTIONS.USER_INVITE,
      subject: AUDIT_SUBJECTS.USER,
      subjectId: id,
    });
  }

  /** Open the login of one employee, or mail its link again when it is already open. */
  async openOrResend(actorId: string, employeeId: number): Promise<LoginOpenedView> {
    const person = await this.db.employee.findUnique({
      where: { id: employeeId },
      select: {
        active: true,
        locale: true,
        login: { select: { id: true, active: true, passwordHash: true } },
      },
    });
    if (!person) {
      throw new NotFoundException("EMPLOYEE_NOT_FOUND");
    }
    if (hasLeft(person)) {
      throw new ConflictException("EMPLOYEE_HAS_LEFT");
    }
    if (person.login) {
      if (!person.login.active) {
        throw new ConflictException("ACCOUNT_LOCKED");
      }
      const why: SetupReason = person.login.passwordHash === UNUSABLE_PASSWORD ? "opened" : "forgot";
      await this.sendSetup(person.login.id, person.locale, why);
      await this.audit.record({
        actorId,
        action: AUDIT_ACTIONS.USER_INVITE,
        subject: AUDIT_SUBJECTS.USER,
        subjectId: person.login.id,
      });
      return { state: "resent" };
    }
    const opened = await this.openFor(employeeId);
    if (opened.skipped === "NO_EMAIL") {
      throw new BadRequestException("NO_EMAIL");
    }
    if (opened.skipped === "EMAIL_TAKEN") {
      throw new ConflictException("EMAIL_TAKEN");
    }
    if (opened.skipped !== undefined) {
      throw new ConflictException("EMPLOYEE_HAS_ACCOUNT");
    }
    await this.audit.record({
      actorId,
      action: AUDIT_ACTIONS.USER_CREATE,
      subject: AUDIT_SUBJECTS.USER,
      subjectId: opened.userId,
      meta: { employeeId },
    });
    return { state: "opened" };
  }

  /** Open logins and mint fresh links for many people at once, the rules of openOrResend (KEHOACH 9.20).
   *  @ctx inside the caller's transaction | hand the jobs to mailSetups once it commits
   *  @ret the letters to send, and whose login landed; an address taken meanwhile opens none
   */
  async stageSetups(
    tx: Prisma.TransactionClient,
    opening: readonly { employeeId: number; email: string; locale: string; manages: boolean }[],
    resending: readonly { userId: string; locale: string }[],
  ): Promise<{ jobs: PasswordSetupJob[]; opened: Map<number, string> }> {
    const fresh = opening.map((one) => ({ ...one, userId: randomUUID() }));
    await tx.user.createMany({
      data: fresh.map((one) => ({
        id: one.userId,
        email: one.email,
        passwordHash: UNUSABLE_PASSWORD,
        role: one.manages ? "MANAGER" : "EMPLOYEE",
        employeeId: one.employeeId,
      })),
      skipDuplicates: true,
    });
    const born = await tx.user.findMany({ where: { id: { in: fresh.map((one) => one.userId) } }, select: { id: true } });
    const landed = new Set(born.map((one) => one.id));
    const opened = fresh.filter((one) => landed.has(one.userId));
    const links = [...opened, ...resending].map((one) => ({
      userId: one.userId,
      locale: one.locale,
      link: randomBytes(LINK_BYTES).toString("base64url"),
    }));
    const expiresAt = new Date(Date.now() + this.config.get("PASSWORD_SETUP_TTL_HOURS", { infer: true }) * HOUR_MS);
    await tx.passwordSetup.createMany({
      data: links.map((one) => ({ userId: one.userId, tokenHash: fingerprint(one.link), expiresAt })),
    });
    const root = this.config.get("APP_PUBLIC_URL", { infer: true });
    return {
      jobs: links.map((one) => ({
        type: JOB.passwordSetup,
        userId: one.userId,
        link: `${root}/${one.locale}/set-password?token=${one.link}`,
        reason: "opened",
      })),
      opened: new Map(opened.map((one) => [one.employeeId, one.userId])),
    };
  }

  /** Queue the letters a committed stageSetups minted. */
  async mailSetups(jobs: readonly PasswordSetupJob[]): Promise<void> {
    await this.queues[QUEUE.notify].addBulk(jobs.map((data) => ({ name: JOB.passwordSetup, data })));
  }

  /** Where the login of one employee stands, for the record page. */
  async loginOf(employeeId: number): Promise<LoginStateView> {
    const person = await this.db.employee.findUnique({
      where: { id: employeeId },
      select: {
        personalEmail: true,
        login: { select: { id: true, email: true, role: true, active: true, passwordHash: true } },
      },
    });
    if (!person) {
      throw new NotFoundException("EMPLOYEE_NOT_FOUND");
    }
    const hasEmail = person.personalEmail !== null;
    const login = person.login;
    if (!login) {
      return { state: "none", email: null, role: null, lastSeenAt: null, hasEmail };
    }
    const seen = await this.lastSeen([login.id]);
    const state = !login.active ? "locked" : login.passwordHash === UNUSABLE_PASSWORD ? "pending" : "active";
    return { state, email: login.email, role: login.role, lastSeenAt: seen.get(login.id) ?? null, hasEmail };
  }

  async create(actorId: string, body: CreateUserDto): Promise<AccountView> {
    let person: Linkable | null = null;
    if (body.employeeId !== undefined) {
      person = await this.personFor(body.employeeId);
      assertLinkable(person, null);
    }
    const role = settledRole(body.role, person);
    let made: AccountRow;
    try {
      made = await this.db.user.create({
        data: {
          email: body.email,
          role,
          passwordHash: UNUSABLE_PASSWORD,
          employeeId: person?.id ?? null,
        },
        select: ACCOUNT,
      });
    } catch (error) {
      throw asTaken(error);
    }
    await this.sendSetup(made.id, person?.locale ?? DEFAULT_MAIL_LOCALE, "opened");
    await this.audit.record({
      actorId,
      action: AUDIT_ACTIONS.USER_CREATE,
      subject: AUDIT_SUBJECTS.USER,
      subjectId: made.id,
      meta: { role: made.role, employeeId: made.employeeId },
    });
    return asAccount(made, null);
  }

  /** Change an account's role, lock, address or employee link under the guards of KEHOACH 9.4. */
  async update(actorId: string, id: string, body: UpdateUserDto): Promise<AccountView> {
    const held = await this.db.user.findUnique({ where: { id }, select: ACCOUNT });
    if (!held) {
      throw new NotFoundException("USER_NOT_FOUND");
    }
    const demotes = body.role !== undefined && body.role !== held.role;
    if (id === actorId && (demotes || body.active === false)) {
      throw new ForbiddenException("SELF_ACCOUNT");
    }
    const employeeId = body.employeeId === undefined ? held.employeeId : body.employeeId;
    const relinks = employeeId !== held.employeeId;
    const person = employeeId === null ? null : await this.personFor(employeeId);
    if (person && relinks) {
      assertLinkable(person, id);
    }
    const unlocks = body.active === true && !held.active;
    if (unlocks && person && hasLeft(person)) {
      throw new ConflictException("EMPLOYEE_HAS_LEFT");
    }
    const role = body.role !== undefined || relinks ? settledRole(body.role ?? held.role, person) : held.role;
    const active = body.active ?? held.active;
    const losesAdmin = held.role === "ADMIN" && held.active && (role !== "ADMIN" || !active);

    let saved: AccountRow;
    try {
      saved = await this.db.$transaction(async (tx) => {
        if (losesAdmin) {
          // Locked rows make two admins demoting each other queue, not both pass (KEHOACH 9.23 rule 3).
          const admins = await tx.$queryRaw<{ id: string }[]>`
            SELECT "id" FROM "User" WHERE "role" = 'ADMIN' AND "active" FOR UPDATE
          `;
          if (!admins.some((one) => one.id !== id)) {
            throw new ConflictException("LAST_ADMIN");
          }
        }
        return tx.user.update({
          where: { id },
          data: { ...(body.email ? { email: body.email } : {}), role, active, employeeId },
          select: ACCOUNT,
        });
      });
    } catch (error) {
      throw asTaken(error);
    }

    // The token carries the role and the employee, so either one moving ends every session (KEHOACH 9.23).
    if (saved.role !== held.role || relinks || (held.active && !saved.active)) {
      await this.auth.closeAll(id);
    }
    await this.recordUpdate(actorId, held, saved);
    const seen = await this.lastSeen([id]);
    return asAccount(saved, seen.get(id) ?? null);
  }

  private async recordUpdate(actorId: string, held: AccountRow, saved: AccountRow): Promise<void> {
    const entry = { actorId, subject: AUDIT_SUBJECTS.USER, subjectId: saved.id };
    if (saved.role !== held.role) {
      await this.audit.record({ ...entry, action: AUDIT_ACTIONS.USER_ROLE, meta: { from: held.role, to: saved.role } });
    }
    if (saved.active !== held.active) {
      await this.audit.record({ ...entry, action: saved.active ? AUDIT_ACTIONS.USER_UNLOCK : AUDIT_ACTIONS.USER_LOCK });
    }
    if (saved.email !== held.email) {
      await this.audit.record({ ...entry, action: AUDIT_ACTIONS.USER_EMAIL });
    }
    if (saved.employeeId !== held.employeeId) {
      await this.audit.record({
        ...entry,
        action: AUDIT_ACTIONS.USER_EMPLOYEE,
        meta: { from: held.employeeId, to: saved.employeeId },
      });
    }
  }

  /** Delete an account nobody ever signed in to; one with a history is locked instead (KEHOACH 9.4). */
  async remove(id: string, actorId: string): Promise<void> {
    if (id === actorId) {
      throw new ForbiddenException("SELF_ACCOUNT");
    }
    const target = await this.db.user.findUnique({ where: { id }, select: { email: true, role: true } });
    if (!target) {
      throw new NotFoundException("USER_NOT_FOUND");
    }
    // The hash in the WHERE: a link redeemed between the read and this delete keeps the account.
    const gone = await this.db.user.deleteMany({ where: { id, passwordHash: UNUSABLE_PASSWORD } });
    if (gone.count === 0) {
      throw new ConflictException("ACCOUNT_HAS_HISTORY");
    }
    await this.audit.record({
      actorId,
      action: AUDIT_ACTIONS.USER_DELETE,
      subject: AUDIT_SUBJECTS.USER,
      subjectId: id,
      meta: { role: target.role },
    });
  }

  /** Move EMPLOYEE and MANAGER accounts of these people to what their direct reports say (KEHOACH 9.4).
   *  @ctx inside the caller's transaction | never touches ADMIN, HR, PAYROLL or VIEWER
   *  @ret the accounts that moved; pass them to settleRoleFlips once the transaction commits
   */
  async syncManagerRoles(
    employeeIds: readonly (number | null | undefined)[],
    tx: Prisma.TransactionClient,
  ): Promise<RoleFlip[]> {
    const ids = [...new Set(employeeIds.filter((one): one is number => typeof one === "number"))];
    if (ids.length === 0) {
      return [];
    }
    const moved = await tx.$queryRaw<{ id: string; role: Role }[]>`
      WITH wanted AS (
        SELECT u."id",
               CASE WHEN EXISTS (
                 SELECT 1 FROM "Employee" r WHERE r."managerId" = u."employeeId" AND r."active"
               ) THEN 'MANAGER'::"Role" ELSE 'EMPLOYEE'::"Role" END AS "role"
          FROM "User" u
         WHERE u."employeeId" = ANY(${ids}::int[])
           AND u."role" IN ('EMPLOYEE'::"Role", 'MANAGER'::"Role")
      )
      UPDATE "User" u
         SET "role" = w."role", "updatedAt" = now()
        FROM wanted w
       WHERE u."id" = w."id" AND u."role" <> w."role"
      RETURNING u."id", u."role"
    `;
    return moved.map((one) => ({
      userId: one.id,
      from: one.role === "MANAGER" ? "EMPLOYEE" : "MANAGER",
      to: one.role,
    }));
  }

  /** End the old tokens of the moved accounts and write each move down.
   *  @ctx after the transaction that produced the flips has committed
   */
  async settleRoleFlips(actorId: string | undefined, flips: RoleFlip[]): Promise<void> {
    if (flips.length === 0) {
      return;
    }
    // A new MANAGER renews into the role without signing out; losing it closes sessions like any demotion (KEHOACH 9.23).
    const promoted = flips.filter((one) => one.to === "MANAGER").map((one) => one.userId);
    if (promoted.length > 0) {
      await this.auth.cutAccess(promoted);
    }
    for (const flip of flips) {
      if (flip.to !== "MANAGER") {
        await this.auth.closeAll(flip.userId);
      }
    }
    for (const flip of flips) {
      await this.audit.record({
        actorId,
        action: AUDIT_ACTIONS.USER_ROLE,
        subject: AUDIT_SUBJECTS.USER,
        subjectId: flip.userId,
        meta: { from: flip.from, to: flip.to, derived: true },
      });
    }
  }

  private async personFor(employeeId: number): Promise<Linkable> {
    const person = await this.db.employee.findUnique({ where: { id: employeeId }, select: LINKABLE });
    if (!person) {
      throw new NotFoundException("EMPLOYEE_NOT_FOUND");
    }
    return person;
  }
}

function assertLinkable(person: Linkable, accountId: string | null): void {
  if (hasLeft(person)) {
    throw new ConflictException("EMPLOYEE_HAS_LEFT");
  }
  if (person.login && person.login.id !== accountId) {
    throw new ConflictException("EMPLOYEE_HAS_ACCOUNT");
  }
}

/** The role an account ends up with: EMPLOYEE and MANAGER are read off the org tree (KEHOACH 9.4). */
function settledRole(asked: Role, person: Linkable | null): Role {
  if (NEEDS_EMPLOYEE.has(asked) && !person) {
    throw new BadRequestException("ROLE_NEEDS_EMPLOYEE");
  }
  if (TREE_ROLES.has(asked) && person) {
    return person._count.reports > 0 ? "MANAGER" : "EMPLOYEE";
  }
  return asked;
}

function asTaken(error: unknown): unknown {
  if (!isCode(error, UNIQUE_VIOLATION)) {
    return error;
  }
  const onEmployee = JSON.stringify((error as { meta?: unknown }).meta ?? "").includes("employeeId");
  return new ConflictException(onEmployee ? "EMPLOYEE_HAS_ACCOUNT" : "EMAIL_ALREADY_HAS_ACCOUNT");
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
