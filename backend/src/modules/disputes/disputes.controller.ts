import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { PayslipDispute } from "@prisma/client";

import type { Page } from "../../common/dto/pagination.dto.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { CurrentViewer, type Viewer } from "../../common/scope/viewer.js";
import { DisputesService } from "./disputes.service.js";
import { AnswerDisputeDto, ListDisputesDto, RaiseDisputeDto } from "./dto/dispute.dto.js";

@ApiTags("payslip-disputes")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("payslip-disputes")
export class DisputesController {
  constructor(private readonly disputes: DisputesService) {}

  @Post()
  @ApiOperation({ summary: "Dispute a figure on a payslip already sent out" })
  raise(@Body() body: RaiseDisputeDto, @CurrentViewer() viewer: Viewer): Promise<PayslipDispute> {
    return this.disputes.raise(viewer, body);
  }

  @Get()
  @ApiOperation({ summary: "Disputes in scope; open ones first, oldest deadline first" })
  list(
    @Query() query: ListDisputesDto,
    @CurrentViewer() viewer: Viewer,
  ): Promise<Page<PayslipDispute>> {
    return this.disputes.list(viewer, query);
  }

  @Post(":id/answer")
  @ApiOperation({ summary: "Answer one; upholding with an amount mints the adjustment" })
  answer(
    @Param("id") id: string,
    @Body() body: AnswerDisputeDto,
    @CurrentViewer() viewer: Viewer,
  ): Promise<PayslipDispute> {
    return this.disputes.answer(viewer, id, body);
  }

  @Post(":id/withdraw")
  @ApiOperation({ summary: "Take back a dispute nobody has answered yet" })
  withdraw(@Param("id") id: string, @CurrentViewer() viewer: Viewer): Promise<PayslipDispute> {
    return this.disputes.withdraw(viewer, id);
  }
}
