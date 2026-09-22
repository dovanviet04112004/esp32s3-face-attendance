import { Body, Controller, Get, Param, ParseIntPipe, Post, Query, UseGuards } from "@nestjs/common";
import { ChecklistKind, type ChecklistTask, type ChecklistTemplate } from "@prisma/client";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import { Roles } from "../../common/decorators/roles.decorator.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { CurrentViewer, type Viewer } from "../../common/scope/viewer.js";
import { CreateTemplateDto, FinishTaskDto, StartRunDto } from "./dto/onboarding.dto.js";
import { OnboardingService, type RunWithTasks } from "./onboarding.service.js";

@ApiTags("onboarding")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller()
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get("checklist-templates")
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "The templates a new hire can be started on" })
  templates(@Query("kind") kind?: ChecklistKind): Promise<ChecklistTemplate[]> {
    return this.onboarding.templates(kind);
  }

  @Post("checklist-templates")
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Add a template and the items it opens" })
  createTemplate(@Body() body: CreateTemplateDto): Promise<ChecklistTemplate> {
    return this.onboarding.createTemplate(body);
  }

  @Post("checklists")
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Pick the template that fits and hand out the work" })
  start(@CurrentViewer() viewer: Viewer, @Body() body: StartRunDto): Promise<RunWithTasks> {
    return this.onboarding.start(viewer, body);
  }

  @Get("checklists/open")
  @ApiOperation({ summary: "Tasks nobody has finished yet, soonest due first" })
  open(@CurrentViewer() viewer: Viewer): Promise<ChecklistTask[]> {
    return this.onboarding.open(viewer);
  }

  @Get("employees/:id/checklist")
  @ApiOperation({ summary: "What is still open on one person's onboarding" })
  run(
    @CurrentViewer() viewer: Viewer,
    @Param("id", ParseIntPipe) id: number,
    @Query("kind") kind?: ChecklistKind,
  ): Promise<RunWithTasks> {
    return this.onboarding.run(viewer, id, kind ?? ChecklistKind.ONBOARDING);
  }

  @Post("checklist-tasks/:id/finish")
  @ApiOperation({ summary: "Mark one onboarding task done" })
  finish(
    @CurrentViewer() viewer: Viewer,
    @Param("id") id: string,
    @Body() body: FinishTaskDto,
  ): Promise<ChecklistTask> {
    return this.onboarding.finish(viewer, id, body);
  }
}
