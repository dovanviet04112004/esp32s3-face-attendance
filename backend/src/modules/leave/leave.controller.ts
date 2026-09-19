import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request as LeaveRequest } from "@prisma/client";

import type { Page } from "../../common/dto/pagination.dto.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { CurrentViewer, type Viewer } from "../../common/scope/viewer.js";
import { DecideRequestDto, ListRequestsDto, SubmitRequestDto } from "./dto/request.dto.js";
import { LeaveService } from "./leave.service.js";

@ApiTags("requests")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("requests")
export class LeaveController {
  constructor(private readonly leave: LeaveService) {}

  @Post()
  @ApiOperation({ summary: "File leave, overtime, a correction or a trip (KEHOACH 9.5)" })
  submit(@CurrentViewer() viewer: Viewer, @Body() body: SubmitRequestDto): Promise<LeaveRequest> {
    return this.leave.submit(viewer, body);
  }

  @Get()
  @ApiOperation({ summary: "Requests this viewer may see, narrowed by their scope" })
  list(@CurrentViewer() viewer: Viewer, @Query() query: ListRequestsDto): Promise<Page<LeaveRequest>> {
    return this.leave.list(viewer, query);
  }

  @Get("inbox")
  @ApiOperation({ summary: "What is waiting on this viewer to answer" })
  inbox(@CurrentViewer() viewer: Viewer, @Query() query: ListRequestsDto): Promise<Page<LeaveRequest>> {
    return this.leave.inbox(viewer, query);
  }

  @Post(":id/decide")
  @ApiOperation({ summary: "Approve or turn down; the balance moves here" })
  decide(
    @CurrentViewer() viewer: Viewer,
    @Param("id") id: string,
    @Body() body: DecideRequestDto,
  ): Promise<LeaveRequest> {
    return this.leave.decide(viewer, id, body);
  }

  @Post(":id/cancel")
  cancel(@CurrentViewer() viewer: Viewer, @Param("id") id: string): Promise<LeaveRequest> {
    return this.leave.cancel(viewer, id);
  }
}
