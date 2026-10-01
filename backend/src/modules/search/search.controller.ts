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
import { SearchQueryDto, SearchReplyView } from "./dto/search.dto.js";
import { SearchService, type Found } from "./search.service.js";

@ApiTags("search")
@ApiBearerAuth(API_AUTH.user)
@ApiErrors(HttpStatus.UNAUTHORIZED)
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller("search")
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Get()
  @ApiOperation({
    summary: "Everything the viewer may open that the term names: people, requests, pay, kiosks, assets, documents",
  })
  @ApiOkResponse({ type: SearchReplyView })
  @ApiBadRequestResponse({ type: ErrorBody, description: "A term longer than 64 characters" })
  find(@CurrentViewer() viewer: Viewer, @Query() query: SearchQueryDto): Promise<Found> {
    return this.search.find(viewer, query.q ?? "");
  }
}
