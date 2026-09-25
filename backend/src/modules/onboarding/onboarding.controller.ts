import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { ChecklistKind } from "@prisma/client";
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";

import { AuditedInService } from "../../common/decorators/audited.decorator.js";
import { API_AUTH, ApiErrors } from "../../common/decorators/api-docs.decorator.js";
import { Roles } from "../../common/decorators/roles.decorator.js";
import { ErrorBody } from "../../common/dto/error-body.dto.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { CurrentViewer, type Viewer } from "../../common/scope/viewer.js";
import type { Page } from "../../common/dto/pagination.dto.js";
import {
  CreateTemplateDto,
  FinishTaskDto,
  FinishedTaskView,
  ListOpenTasksDto,
  ListTemplatesDto,
  OpenCountsDto,
  OpenCountsView,
  RunQueryDto,
  StartRunDto,
  TemplateView,
  UpdateTemplateDto,
} from "./dto/onboarding.dto.js";
import {
  OnboardingService,
  type FinishedTask,
  type OpenCounts,
  type OpenTask,
  type RunWithTasks,
  type TemplateRow,
} from "./onboarding.service.js";

@ApiTags("onboarding")
@ApiBearerAuth(API_AUTH.user)
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiErrors(HttpStatus.BAD_REQUEST, HttpStatus.UNAUTHORIZED, HttpStatus.FORBIDDEN)
@Controller()
export class OnboardingController {
  constructor(private readonly onboarding: OnboardingService) {}

  @Get("checklist-templates")
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "The templates a new hire can be started on" })
  @ApiOkResponse({ type: [TemplateView] })
  templates(@Query() query: ListTemplatesDto): Promise<TemplateRow[]> {
    return this.onboarding.templates(query);
  }

  @Post("checklist-templates")
  @AuditedInService()
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Add a template and the items it opens" })
  @ApiCreatedResponse({ type: TemplateView })
  @ApiNotFoundResponse({ type: ErrorBody, description: "AUDIENCE_NOT_FOUND" })
  createTemplate(@CurrentViewer() viewer: Viewer, @Body() body: CreateTemplateDto): Promise<TemplateRow> {
    return this.onboarding.createTemplate(viewer, body);
  }

  @Patch("checklist-templates/:id")
  @AuditedInService()
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Edit, retire or restore a template; items sent replace the list" })
  @ApiOkResponse({ type: TemplateView })
  @ApiNotFoundResponse({ type: ErrorBody, description: "TEMPLATE_NOT_FOUND | AUDIENCE_NOT_FOUND" })
  updateTemplate(
    @CurrentViewer() viewer: Viewer,
    @Param("id") id: string,
    @Body() body: UpdateTemplateDto,
  ): Promise<TemplateRow> {
    return this.onboarding.updateTemplate(viewer, id, body);
  }

  @Post("checklists")
  @Roles("ADMIN", "HR")
  @ApiOperation({ summary: "Pick the template that fits and hand out the work" })
  @ApiNotFoundResponse({ type: ErrorBody, description: "EMPLOYEE_NOT_FOUND | NO_CHECKLIST_TEMPLATE" })
  @ApiConflictResponse({ type: ErrorBody, description: "CHECKLIST_ALREADY_STARTED" })
  start(@CurrentViewer() viewer: Viewer, @Body() body: StartRunDto): Promise<RunWithTasks> {
    return this.onboarding.start(viewer, body);
  }

  @Get("checklists/open")
  @ApiOperation({ summary: "Tasks nobody has finished yet, soonest due first" })
  open(@CurrentViewer() viewer: Viewer, @Query() query: ListOpenTasksDto): Promise<Page<OpenTask>> {
    return this.onboarding.open(viewer, query);
  }

  @Get("checklists/open/counts")
  @ApiOperation({ summary: "Open tasks, the late ones, and who each waits on, under the same filters" })
  @ApiOkResponse({ type: OpenCountsView })
  openCounts(@CurrentViewer() viewer: Viewer, @Query() query: OpenCountsDto): Promise<OpenCounts> {
    return this.onboarding.openCounts(viewer, query);
  }

  @Get("employees/:id/checklist")
  @ApiOperation({ summary: "What is still open on one person's onboarding" })
  @ApiNotFoundResponse({ type: ErrorBody, description: "EMPLOYEE_NOT_FOUND" })
  run(
    @CurrentViewer() viewer: Viewer,
    @Param("id", ParseIntPipe) id: number,
    @Query() query: RunQueryDto,
  ): Promise<RunWithTasks | null> {
    return this.onboarding.run(viewer, id, query.kind ?? ChecklistKind.ONBOARDING);
  }

  @Post("checklist-tasks/:id/finish")
  @ApiOperation({ summary: "Mark one onboarding task done" })
  @ApiCreatedResponse({ type: FinishedTaskView })
  @ApiForbiddenResponse({ type: ErrorBody, description: "SELF_DECISION" })
  @ApiNotFoundResponse({ type: ErrorBody, description: "TASK_NOT_FOUND" })
  @ApiConflictResponse({ type: ErrorBody, description: "TASK_ALREADY_DONE" })
  finish(
    @CurrentViewer() viewer: Viewer,
    @Param("id") id: string,
    @Body() body: FinishTaskDto,
  ): Promise<FinishedTask> {
    return this.onboarding.finish(viewer, id, body);
  }
}
