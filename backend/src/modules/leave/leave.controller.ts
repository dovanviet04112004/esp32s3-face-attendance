import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { LeaveType, Request as LeaveRequest } from "@prisma/client";

import type { Page } from "../../common/dto/pagination.dto.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { CurrentViewer, type Viewer } from "../../common/scope/viewer.js";
import { BalanceQueryDto, DecideRequestDto, ListRequestsDto, SubmitRequestDto } from "./dto/request.dto.js";
import { LeaveService, type BalanceAsOf } from "./leave.service.js";

@ApiTags("requests")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller()
export class LeaveController {
  constructor(private readonly leave: LeaveService) {}

  @Get("leave-types")
  types(): Promise<LeaveType[]> {
    return this.leave.types();
  }

  @Get("leave-balances")
  @ApiOperation({ summary: "What somebody has left on a day of the caller's choosing" })
  balances(
    @CurrentViewer() viewer: Viewer,
    @Query() query: BalanceQueryDto,
  ): Promise<BalanceAsOf[]> {
    return this.leave.balancesFor(viewer, query.employeeId, new Date(query.asOf ?? Date.now()));
  }

  @Post("requests")
  @ApiOperation({ summary: "File leave, overtime, a correction or a trip (KEHOACH 9.5)" })
  submit(@CurrentViewer() viewer: Viewer, @Body() body: SubmitRequestDto): Promise<LeaveRequest> {
    return this.leave.submit(viewer, body);
  }

  @Get("requests")
  @ApiOperation({ summary: "Requests this viewer may see, narrowed by their scope" })
  list(@CurrentViewer() viewer: Viewer, @Query() query: ListRequestsDto): Promise<Page<LeaveRequest>> {
    return this.leave.list(viewer, query);
  }

  @Get("requests/inbox")
  @ApiOperation({ summary: "What is waiting on this viewer to answer" })
  inbox(@CurrentViewer() viewer: Viewer, @Query() query: ListRequestsDto): Promise<Page<LeaveRequest>> {
    return this.leave.inbox(viewer, query);
  }

  @Get("requests/:id")
  @ApiOperation({ summary: "One request; declared after inbox so the word is not an id" })
  one(@CurrentViewer() viewer: Viewer, @Param("id") id: string): Promise<LeaveRequest> {
    return this.leave.one(viewer, id);
  }

  @Post("requests/:id/decide")
  @ApiOperation({ summary: "Approve or turn down; the balance moves here" })
  decide(
    @CurrentViewer() viewer: Viewer,
    @Param("id") id: string,
    @Body() body: DecideRequestDto,
  ): Promise<LeaveRequest> {
    return this.leave.decide(viewer, id, body);
  }

  @Post("requests/:id/cancel")
  cancel(@CurrentViewer() viewer: Viewer, @Param("id") id: string): Promise<LeaveRequest> {
    return this.leave.cancel(viewer, id);
  }
}
