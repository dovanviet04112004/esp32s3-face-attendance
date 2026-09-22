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
  Query,
  UseGuards,
} from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Shift, ShiftAssignment } from "@prisma/client";

import { Roles } from "../../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { AssignShiftDto, CreateShiftDto, UpdateShiftDto , RosterDto } from "./dto/shift.dto.js";
import { CurrentViewer, type Viewer } from "../../common/scope/viewer.js";
import { ShiftsService, type PlannedDay } from "./shifts.service.js";

@ApiTags("shifts")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("shifts")
export class ShiftsController {
  constructor(private readonly shifts: ShiftsService) {}

  @Get()
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Every shift, retired ones included" })
  list(): Promise<Shift[]> {
    return this.shifts.list();
  }

  @Get("roster")
  @ApiOperation({ summary: "One person's month ahead: shift, holiday, days away" })
  roster(@Query() query: RosterDto, @CurrentViewer() viewer: Viewer): Promise<PlannedDay[]> {
    return this.shifts.roster(viewer, query);
  }

  @Get(":id")
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "One shift and the hours it keeps" })
  get(@Param("id") id: string): Promise<Shift> {
    return this.shifts.get(id);
  }

  @Post()
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Add a shift" })
  create(@Body() body: CreateShiftDto): Promise<Shift> {
    return this.shifts.create(body);
  }

  @Patch(":id")
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Change a shift's hours or its grace" })
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
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Who works this shift, and from when" })
  assignments(@Param("id") id: string): Promise<ShiftAssignment[]> {
    return this.shifts.assignments(id);
  }

  @Post(":id/assignments")
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Put somebody on this shift from a date" })
  assign(@Param("id") id: string, @Body() body: AssignShiftDto): Promise<ShiftAssignment> {
    return this.shifts.assign(id, body);
  }

  @Delete(":id/assignments/:assignmentId")
  @Roles("ADMIN", "HR")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Take somebody off this shift" })
  unassign(
    @Param("id") id: string,
    @Param("assignmentId") assignmentId: string,
  ): Promise<void> {
    return this.shifts.unassign(id, assignmentId);
  }
}
