import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Shift, ShiftAssignment } from "@prisma/client";

import { Roles } from "../../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { AssignShiftDto, CreateShiftDto, UpdateShiftDto } from "./dto/shift.dto.js";
import { ShiftsService } from "./shifts.service.js";

@ApiTags("shifts")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("shifts")
export class ShiftsController {
  constructor(private readonly shifts: ShiftsService) {}

  @Get()
  list(): Promise<Shift[]> {
    return this.shifts.list();
  }

  @Get(":id")
  get(@Param("id") id: string): Promise<Shift> {
    return this.shifts.get(id);
  }

  @Post()
  @Roles("ADMIN", "HR")
  create(@Body() body: CreateShiftDto): Promise<Shift> {
    return this.shifts.create(body);
  }

  @Patch(":id")
  @Roles("ADMIN", "HR")
  update(@Param("id") id: string, @Body() body: UpdateShiftDto): Promise<Shift> {
    return this.shifts.update(id, body);
  }

  @Delete(":id")
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Retire a shift; assignments already made stay readable" })
  deactivate(@Param("id") id: string): Promise<Shift> {
    return this.shifts.deactivate(id);
  }

  @Get(":id/assignments")
  assignments(@Param("id") id: string): Promise<ShiftAssignment[]> {
    return this.shifts.assignments(id);
  }

  @Post(":id/assignments")
  @Roles("ADMIN", "HR")
  assign(@Param("id") id: string, @Body() body: AssignShiftDto): Promise<ShiftAssignment> {
    return this.shifts.assign(id, body);
  }

  @Delete(":id/assignments/:assignmentId")
  @Roles("ADMIN", "HR")
  @HttpCode(HttpStatus.NO_CONTENT)
  unassign(
    @Param("id") id: string,
    @Param("assignmentId") assignmentId: string,
  ): Promise<void> {
    return this.shifts.unassign(id, assignmentId);
  }
}
