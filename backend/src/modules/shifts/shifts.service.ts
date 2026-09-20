import { ConflictException, Injectable, NotFoundException } from "@nestjs/common";
import type { Shift, ShiftAssignment } from "@prisma/client";

import { PrismaService } from "../../database/prisma.service.js";
import type { AssignShiftDto, CreateShiftDto, UpdateShiftDto } from "./dto/shift.dto.js";

const UNIQUE_VIOLATION = "P2002";
const FOREIGN_KEY_VIOLATION = "P2003";

@Injectable()
export class ShiftsService {
  constructor(private readonly db: PrismaService) {}

  list(): Promise<Shift[]> {
    return this.db.shift.findMany({ orderBy: { startTime: "asc" } });
  }

  async get(id: string): Promise<Shift> {
    const found = await this.db.shift.findUnique({ where: { id } });
    if (!found) {
      throw new NotFoundException(`no shift ${id}`);
    }
    return found;
  }

  async create(body: CreateShiftDto): Promise<Shift> {
    try {
      return await this.db.shift.create({ data: body });
    } catch (error) {
      if (isCode(error, UNIQUE_VIOLATION)) {
        throw new ConflictException(`shift name ${body.name} is taken`);
      }
      throw error;
    }
  }

  async update(id: string, body: UpdateShiftDto): Promise<Shift> {
    await this.get(id);
    return this.db.shift.update({ where: { id }, data: body });
  }

  async deactivate(id: string): Promise<Shift> {
    await this.get(id);
    return this.db.shift.update({ where: { id }, data: { active: false } });
  }

  async assignments(id: string): Promise<ShiftAssignment[]> {
    await this.get(id);
    return this.db.shiftAssignment.findMany({
      where: { shiftId: id },
      orderBy: { validFrom: "desc" },
    });
  }

  async assign(id: string, body: AssignShiftDto): Promise<ShiftAssignment> {
    await this.get(id);
    try {
      return await this.db.shiftAssignment.create({
        data: {
          shiftId: id,
          employeeId: body.employeeId,
          validFrom: new Date(body.validFrom),
          validTo: body.validTo ? new Date(body.validTo) : null,
        },
      });
    } catch (error) {
      if (isCode(error, UNIQUE_VIOLATION)) {
        throw new ConflictException("SHIFT_ALREADY_ASSIGNED");
      }
      if (isCode(error, FOREIGN_KEY_VIOLATION)) {
        throw new NotFoundException(`no employee ${body.employeeId}`);
      }
      throw error;
    }
  }

  async unassign(id: string, assignmentId: string): Promise<void> {
    const found = await this.db.shiftAssignment.findFirst({
      where: { id: assignmentId, shiftId: id },
    });
    if (!found) {
      throw new NotFoundException(`no assignment ${assignmentId} on shift ${id}`);
    }
    await this.db.shiftAssignment.delete({ where: { id: assignmentId } });
  }
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
