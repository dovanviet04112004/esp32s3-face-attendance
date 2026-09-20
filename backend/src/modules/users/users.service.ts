import { randomBytes } from "node:crypto";

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import type { Role, User } from "@prisma/client";

import type { Page, PaginationDto } from "../../common/dto/pagination.dto.js";
import { PrismaService } from "../../database/prisma.service.js";

import { hashPassword } from "../auth/password.js";
import type { CreateUserDto, UpdateUserDto } from "./dto/user.dto.js";

const UNIQUE_VIOLATION = "P2002";

/** A user as an api may show one: no hash, no refresh fingerprint. */
export type PublicUser = Pick<User, "id" | "email" | "role" | "createdAt" | "updatedAt">;

const VISIBLE = {
  id: true,
  email: true,
  role: true,
  createdAt: true,
  updatedAt: true,
} as const;

/** What an admin sees once after provisioning, and never again. */
export interface ProvisionedAccount {
  employeeCode: string;
  email: string;
  password: string;
  role: string;
}

@Injectable()
export class UsersService {
  private readonly log = new Logger(UsersService.name);

  constructor(private readonly db: PrismaService) {}


  /** Open a login for every active employee who has an address and none yet.
   *  Whoever has people reporting to them starts as MANAGER, so the approval
   *  inbox is not empty on day one (KEHOACH 9.4).
   */
  async provision(): Promise<ProvisionedAccount[]> {
    const waiting = await this.db.employee.findMany({
      where: { active: true, login: null, personalEmail: { not: null } },
      select: { id: true, code: true, personalEmail: true, _count: { select: { reports: true } } },
      orderBy: { code: "asc" },
    });
    const made: ProvisionedAccount[] = [];
    for (const person of waiting) {
      // Shown to the admin once and never stored in the clear.
      const password = randomBytes(12).toString("base64url");
      const role = person._count.reports > 0 ? "MANAGER" : "EMPLOYEE";
      try {
        await this.db.user.create({
          data: {
            email: person.personalEmail as string,
            passwordHash: await hashPassword(password),
            role,
            employeeId: person.id,
          },
        });
      } catch (error) {
        if (isCode(error, UNIQUE_VIOLATION)) {
          continue;
        }
        throw error;
      }
      made.push({ employeeCode: person.code, email: person.personalEmail as string, password, role });
    }
    this.log.log(`opened ${made.length} employee login(s)`);
    return made;
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

  async create(body: CreateUserDto): Promise<PublicUser> {
    try {
      return await this.db.user.create({
        data: {
          email: body.email,
          role: body.role as Role,
          passwordHash: await hashPassword(body.password),
        },
        select: VISIBLE,
      });
    } catch (error) {
      if (isCode(error, UNIQUE_VIOLATION)) {
        throw new ConflictException(`${body.email} already has an account`);
      }
      throw error;
    }
  }

  async update(id: string, body: UpdateUserDto): Promise<PublicUser> {
    await this.get(id);
    return this.db.user.update({
      where: { id },
      data: {
        ...(body.email ? { email: body.email } : {}),
        ...(body.role ? { role: body.role as Role } : {}),
        // A new password retires the session that used the old one.
        ...(body.password
          ? { passwordHash: await hashPassword(body.password), refreshTokenHash: null }
          : {}),
      },
      select: VISIBLE,
    });
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
