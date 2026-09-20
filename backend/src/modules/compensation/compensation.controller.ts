import { Body, Controller, Get, Param, ParseIntPipe, Post, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Dependent } from "@prisma/client";

import { Roles } from "../../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { CurrentViewer, type Viewer } from "../../common/scope/viewer.js";
import { CompensationService, type PayRecord, type RaisePreview } from "./compensation.service.js";
import {
  BulkRaiseDto,
  CreateCompensationDto,
  CreateDependentDto,
  DecideDependentDto,
} from "./dto/compensation.dto.js";

@ApiTags("compensation")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller()
export class CompensationController {
  constructor(private readonly pay: CompensationService) {}

  @Get("employees/:id/compensation")
  @ApiOperation({ summary: "Every pay record for one person, newest first" })
  history(
    @CurrentViewer() viewer: Viewer,
    @Param("id", ParseIntPipe) id: number,
  ): Promise<PayRecord[]> {
    return this.pay.history(viewer, id);
  }

  @Post("compensation")
  @Roles("ADMIN", "PAYROLL")
  @ApiOperation({ summary: "A raise appends a record; nothing is overwritten" })
  create(@CurrentViewer() viewer: Viewer, @Body() body: CreateCompensationDto): Promise<PayRecord> {
    return this.pay.create(viewer, body);
  }

  @Post("compensation/bulk/preview")
  @Roles("ADMIN", "PAYROLL")
  @ApiOperation({ summary: "What a bulk raise would write" })
  preview(@CurrentViewer() viewer: Viewer, @Body() body: BulkRaiseDto): Promise<RaisePreview[]> {
    return this.pay.previewRaise(viewer, body);
  }

  @Post("compensation/bulk")
  @Roles("ADMIN", "PAYROLL")
  @ApiOperation({ summary: "Write the raise the preview showed" })
  bulk(@CurrentViewer() viewer: Viewer, @Body() body: BulkRaiseDto): Promise<{ written: number }> {
    return this.pay.applyRaise(viewer, body);
  }

  @Get("employees/:id/dependents")
  @ApiOperation({ summary: "Dependants registered against one person" })
  dependents(
    @CurrentViewer() viewer: Viewer,
    @Param("id", ParseIntPipe) id: number,
  ): Promise<Dependent[]> {
    return this.pay.dependents(viewer, id);
  }

  @Post("dependents")
  @ApiOperation({ summary: "Register a dependant; HR decides on it" })
  add(@CurrentViewer() viewer: Viewer, @Body() body: CreateDependentDto): Promise<Dependent> {
    return this.pay.addDependent(viewer, body);
  }

  @Post("dependents/:id/decide")
  @Roles("ADMIN", "PAYROLL")
  @ApiOperation({ summary: "Accept or turn down a registration" })
  decide(
    @CurrentViewer() viewer: Viewer,
    @Param("id") id: string,
    @Body() body: DecideDependentDto,
  ): Promise<Dependent> {
    return this.pay.decideDependent(viewer, id, body);
  }
}
