import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { Department, EmploymentContract, JobTitle, LegalEntity } from "@prisma/client";

import { PrismaService } from "../../database/prisma.service.js";
import { AuditService } from "../audit/audit.service.js";
import type {
  CreateContractDto,
  CreateDepartmentDto,
  DecideContractDto,
  UpdateDepartmentDto,
} from "./dto/org.dto.js";

const UNIQUE_VIOLATION = "P2002";

@Injectable()
export class OrgService {
  constructor(
    private readonly db: PrismaService,
    private readonly audit: AuditService,
  ) {}

  contracts(employeeId: number): Promise<EmploymentContract[]> {
    return this.db.employmentContract.findMany({
      where: { employeeId },
      orderBy: { startDate: "desc" },
    });
  }

  /**
   * Re-signing is a new contract, not an edit of the old one: the old terms
   * are what a dispute two years from now asks about (KEHOACH 9.3).
   */
  async addContract(
    body: CreateContractDto,
    actorId: string,
  ): Promise<EmploymentContract> {
    const made = await this.db.employmentContract.create({
      data: {
        employeeId: body.employeeId,
        kind: body.kind,
        number: body.number ?? null,
        startDate: new Date(body.startDate),
        endDate: body.endDate ? new Date(body.endDate) : null,
        probationEnd: body.probationEnd ? new Date(body.probationEnd) : null,
        note: body.note ?? null,
      },
    });
    await this.audit.record({
      actorId,
      action: "contract.create",
      target: made.id,
      meta: { employeeId: body.employeeId, kind: body.kind, endDate: body.endDate ?? null },
    });
    return made;
  }

  /** Only one contract stands at a time, so activating one ends the others. */
  async decideContract(
    id: string,
    body: DecideContractDto,
    actorId: string,
  ): Promise<EmploymentContract> {
    const held = await this.db.employmentContract.findUnique({ where: { id } });
    if (!held) {
      throw new NotFoundException("CONTRACT_NOT_FOUND");
    }
    const moved = await this.db.$transaction(async (tx) => {
      if (body.state === "ACTIVE") {
        await tx.employmentContract.updateMany({
          where: { employeeId: held.employeeId, state: "ACTIVE", id: { not: id } },
          data: { state: "ENDED" },
        });
      }
      return tx.employmentContract.update({
        where: { id },
        data: {
          state: body.state,
          note: body.note ?? held.note,
          signedAt: body.state === "ACTIVE" ? (held.signedAt ?? new Date()) : held.signedAt,
        },
      });
    });
    await this.audit.record({
      actorId,
      action: `contract.${body.state.toLowerCase()}`,
      target: id,
      meta: { employeeId: held.employeeId },
    });
    return moved;
  }

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
        throw new ConflictException("DEPARTMENT_CYCLE");
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
