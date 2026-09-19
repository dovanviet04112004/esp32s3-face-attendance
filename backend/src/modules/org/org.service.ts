import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { Department, JobTitle, LegalEntity } from "@prisma/client";

import { PrismaService } from "../../database/prisma.service.js";
import type { CreateDepartmentDto, UpdateDepartmentDto } from "./dto/org.dto.js";

const UNIQUE_VIOLATION = "P2002";

@Injectable()
export class OrgService {
  constructor(private readonly db: PrismaService) {}

  entities(): Promise<LegalEntity[]> {
    return this.db.legalEntity.findMany({ where: { active: true }, orderBy: { code: "asc" } });
  }

  jobTitles(): Promise<JobTitle[]> {
    return this.db.jobTitle.findMany({ where: { active: true }, orderBy: { code: "asc" } });
  }

  /** The whole tree flat, carrying parentId so a caller shapes it once. */
  departments(legalEntityId?: string): Promise<Department[]> {
    return this.db.department.findMany({
      where: { active: true, ...(legalEntityId ? { legalEntityId } : {}) },
      orderBy: [{ legalEntityId: "asc" }, { code: "asc" }],
    });
  }

  async createDepartment(body: CreateDepartmentDto): Promise<Department> {
    await this.mustExist(body.parentId);
    try {
      return await this.db.department.create({ data: body });
    } catch (error) {
      if (isCode(error, UNIQUE_VIOLATION)) {
        throw new ConflictException(`department code ${body.code} is taken in that entity`);
      }
      throw error;
    }
  }

  async updateDepartment(id: string, body: UpdateDepartmentDto): Promise<Department> {
    if (body.parentId !== undefined) {
      await this.mustExist(body.parentId);
      await this.mustNotLoop(id, body.parentId);
    }
    return this.db.department.update({ where: { id }, data: body });
  }

  private async mustExist(parentId?: string | null): Promise<void> {
    if (!parentId) {
      return;
    }
    const held = await this.db.department.findUnique({ where: { id: parentId } });
    if (!held) {
      throw new NotFoundException(`no department ${parentId}`);
    }
  }

  // A cycle is not caught by any constraint, and it hangs every walk of the tree.
  private async mustNotLoop(id: string, parentId: string | null): Promise<void> {
    let at: string | null = parentId;
    while (at) {
      if (at === id) {
        throw new ConflictException("that parent sits under this department");
      }
      const up: { parentId: string | null } | null = await this.db.department.findUnique({
        where: { id: at },
        select: { parentId: true },
      });
      at = up?.parentId ?? null;
    }
  }
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
