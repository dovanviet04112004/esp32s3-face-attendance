import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { Employee, Prisma } from "@prisma/client";

import type { Page } from "../../common/dto/pagination.dto.js";
import { PrismaService } from "../../database/prisma.service.js";
import type {
  CreateEmployeeDto,
  ListEmployeesDto,
  UpdateEmployeeDto,
} from "./dto/employee.dto.js";

const UNIQUE_VIOLATION = "P2002";

// One join rather than a lookup per row: the table shows a department by name.
const EMPLOYEE_VIEW = {
  department: { select: { id: true, code: true, name: true } },
  jobTitle: { select: { id: true, code: true, name: true } },
  manager: { select: { id: true, code: true, fullName: true } },
} as const;

@Injectable()
export class EmployeesService {
  constructor(private readonly db: PrismaService) {}

  async list(query: ListEmployeesDto): Promise<Page<Employee>> {
    const where: Prisma.EmployeeWhereInput = {
      ...(query.departmentId ? { departmentId: query.departmentId } : {}),
      ...(query.search
        ? {
            OR: [
              { code: { contains: query.search, mode: "insensitive" } },
              { fullName: { contains: query.search, mode: "insensitive" } },
            ],
          }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.db.employee.findMany({
        where,
        skip: query.skip,
        take: query.take,
        orderBy: { code: "asc" },
        include: EMPLOYEE_VIEW,
      }),
      this.db.employee.count({ where }),
    ]);
    return { rows, total };
  }

  async get(id: number): Promise<Employee> {
    const found = await this.db.employee.findUnique({ where: { id }, include: EMPLOYEE_VIEW });
    if (!found) {
      throw new NotFoundException(`no employee ${id}`);
    }
    return found;
  }

  async create(body: CreateEmployeeDto): Promise<Employee> {
    try {
      return await this.db.employee.create({ data: body });
    } catch (error) {
      if (isCode(error, UNIQUE_VIOLATION)) {
        throw new ConflictException(`employee code ${body.code} is taken`);
      }
      throw error;
    }
  }

  async update(id: number, body: UpdateEmployeeDto): Promise<Employee> {
    await this.get(id);
    try {
      return await this.db.employee.update({ where: { id }, data: body });
    } catch (error) {
      if (isCode(error, UNIQUE_VIOLATION)) {
        throw new ConflictException(`employee code ${body.code} is taken`);
      }
      throw error;
    }
  }

  /** Retire an employee without erasing them: attendance rows point here, and
   *  someone who left still has a history. E11-T6 turns this into a roster
   *  push that reaches the kiosks (KEHOACH 7.5).
   */
  async deactivate(id: number): Promise<Employee> {
    await this.get(id);
    return this.db.employee.update({ where: { id }, data: { active: false } });
  }
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
