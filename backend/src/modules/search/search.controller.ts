import { Controller, Get, Query, UseGuards } from "@nestjs/common";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";

import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { CurrentViewer, type Viewer } from "../../common/scope/viewer.js";
import { SearchService, type Hit } from "./search.service.js";

@ApiTags("search")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("search")
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  @ApiOperation({ summary: "People, departments, requests and payslips in one answer" })
  find(@CurrentViewer() viewer: Viewer, @Query("q") q?: string): Promise<Hit[]> {
    return this.search.find(viewer, q ?? "");
  }
}
