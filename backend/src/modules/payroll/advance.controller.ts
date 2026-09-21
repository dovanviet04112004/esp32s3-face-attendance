import { Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { SalaryAdvance } from "@prisma/client";

import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import type { Page } from "../../common/dto/pagination.dto.js";
import { CurrentViewer, type Viewer } from "../../common/scope/viewer.js";
import { AdvanceService } from "./advance.service.js";
import { DecideAdvanceDto, ListAdvancesDto, RequestAdvanceDto } from "./dto/advance.dto.js";

@ApiTags("advances")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("advances")
export class AdvanceController {
  constructor(private readonly advances: AdvanceService) {}

  @Get()
  @ApiOperation({ summary: "Advances this viewer may see, narrowed by their scope" })
  list(
    @CurrentViewer() viewer: Viewer,
    @Query() query: ListAdvancesDto,
  ): Promise<Page<SalaryAdvance>> {
    return this.advances.list(viewer, query);
  }

  @Post()
  @ApiOperation({ summary: "Ask for an advance against next month's pay" })
  submit(@CurrentViewer() viewer: Viewer, @Body() body: RequestAdvanceDto): Promise<SalaryAdvance> {
    return this.advances.submit(viewer, body);
  }

  @Post(":id/decide")
  @ApiOperation({ summary: "Approve or turn down; paying is a separate step" })
  decide(
    @CurrentViewer() viewer: Viewer,
    @Param("id") id: string,
    @Body() body: DecideAdvanceDto,
  ): Promise<SalaryAdvance> {
    return this.advances.decide(viewer, id, body);
  }

  @Post(":id/paid")
  @ApiOperation({ summary: "Record that the money went out; payroll deducts it next" })
  markPaid(@CurrentViewer() viewer: Viewer, @Param("id") id: string): Promise<SalaryAdvance> {
    return this.advances.markPaid(viewer, id);
  }

  @Post(":id/cancel")
  @ApiOperation({ summary: "Withdraw one's own request while it still waits" })
  cancel(@CurrentViewer() viewer: Viewer, @Param("id") id: string): Promise<SalaryAdvance> {
    return this.advances.cancel(viewer, id);
  }
}
