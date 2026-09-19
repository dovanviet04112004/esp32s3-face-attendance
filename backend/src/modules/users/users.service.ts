import { BadRequestException, ConflictException, Injectable, NotFoundException } from "@nestjs/common";
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

@Injectable()
export class UsersService {
  constructor(private readonly db: PrismaService) {}

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
      throw new BadRequestException("an account cannot delete itself");
    }
    const target = await this.get(id);
    if (target.role === "ADMIN") {
      const admins = await this.db.user.count({ where: { role: "ADMIN" } });
      if (admins <= 1) {
        throw new BadRequestException("the last administrator cannot be removed");
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
