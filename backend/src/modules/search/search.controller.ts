import { Controller, Get, HttpStatus, Query, UseGuards } from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";

import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { CurrentViewer, type Viewer } from "../../common/scope/viewer.js";
import { API_AUTH, ApiErrors } from "../../common/decorators/api-docs.decorator.js";
import { ErrorBody } from "../../common/dto/error-body.dto.js";
import { HitView, SearchQueryDto } from "./dto/search.dto.js";
import { SearchService, type Hit } from "./search.service.js";

@ApiTags("search")
@ApiBearerAuth(API_AUTH.user)
@ApiErrors(HttpStatus.UNAUTHORIZED)
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("search")
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  @ApiOperation({ summary: "People, departments, requests and payslips in one answer, each in the viewer's scope" })
  @ApiOkResponse({ type: [HitView] })
  @ApiBadRequestResponse({ type: ErrorBody, description: "A term longer than 64 characters" })
  find(@CurrentViewer() viewer: Viewer, @Query() query: SearchQueryDto): Promise<Hit[]> {
    return this.search.find(viewer, query.q ?? "");
  }
}
