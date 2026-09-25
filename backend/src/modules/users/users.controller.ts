import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from "@nestjs/swagger";
import type { Request } from "express";

import { ApiErrors } from "../../common/decorators/api-docs.decorator.js";
import { AuditedInService } from "../../common/decorators/audited.decorator.js";
import { Roles } from "../../common/decorators/roles.decorator.js";
import { ErrorBody } from "../../common/dto/error-body.dto.js";
import type { Page } from "../../common/dto/pagination.dto.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { CurrentViewer, type Viewer } from "../../common/scope/viewer.js";
import type { AccessClaims } from "../auth/auth.types.js";
import {
  AccountCounts,
  AccountPage,
  AccountView,
  CreateUserDto,
  ListUsersDto,
  MeView,
  UpdateUserDto,
  UserFilterDto,
} from "./dto/user.dto.js";
import { UsersService, type Provisioning } from "./users.service.js";

function actorOf(req: Request): string {
  return (req.user as AccessClaims).sub;
}

@ApiTags("users")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@ApiErrors(HttpStatus.UNAUTHORIZED)
@ApiForbiddenResponse({ type: ErrorBody, description: "Not an administrator; SELF_ACCOUNT when acting on one's own account" })
@Controller("users")
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @Roles("ADMIN")
  @ApiOperation({ summary: "List accounts by email, with the person and department each is linked to" })
  @ApiOkResponse({ type: AccountPage })
  @ApiBadRequestResponse({ type: ErrorBody, description: "CURSOR_INVALID, or a filter outside its enum" })
  list(@Query() query: ListUsersDto): Promise<Page<AccountView>> {
    return this.users.list(query);
  }

  @Get("counts")
  @Roles("ADMIN")
  @ApiOperation({ summary: "Accounts per role and per status, each under the other filters" })
  @ApiOkResponse({ type: AccountCounts })
  counts(@Query() query: UserFilterDto): Promise<AccountCounts> {
    return this.users.counts(query);
  }

  @Get("me")
  @ApiOperation({ summary: "The signed-in account: email, role and linked person, for the account menu" })
  @ApiOkResponse({ type: MeView })
  @ApiNotFoundResponse({ type: ErrorBody, description: "USER_NOT_FOUND" })
  me(@CurrentViewer() viewer: Viewer): Promise<MeView> {
    return this.users.me(viewer.userId);
  }

  @Post("provision")
  @Roles("ADMIN")
  @ApiOperation({ summary: "Open a login for employees who have none (KEHOACH 9.4)" })
  provision(): Promise<Provisioning> {
    return this.users.provision();
  }

  @Post()
  @Roles("ADMIN")
  @AuditedInService()
  @ApiOperation({ summary: "Open a login with any of the six roles and mail its one-time setup link" })
  @ApiCreatedResponse({ type: AccountView })
  @ApiBadRequestResponse({ type: ErrorBody, description: "ROLE_NEEDS_EMPLOYEE: EMPLOYEE, MANAGER and PAYROLL need employeeId" })
  @ApiNotFoundResponse({ type: ErrorBody, description: "EMPLOYEE_NOT_FOUND" })
  @ApiConflictResponse({ type: ErrorBody, description: "EMAIL_ALREADY_HAS_ACCOUNT, EMPLOYEE_HAS_ACCOUNT, EMPLOYEE_HAS_LEFT" })
  create(@Body() body: CreateUserDto, @Req() req: Request): Promise<AccountView> {
    return this.users.create(actorOf(req), body);
  }

  @Post(":id/invite")
  @Roles("ADMIN")
  @AuditedInService()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Mail the setup link again, for a password nobody can recall" })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ type: ErrorBody, description: "USER_NOT_FOUND, also for a locked account" })
  invite(@Param("id") id: string, @Req() req: Request): Promise<void> {
    return this.users.invite(actorOf(req), id);
  }

  @Patch(":id")
  @Roles("ADMIN")
  @AuditedInService()
  @ApiOperation({
    summary: "Change role, lock or unlock, address or linked employee (KEHOACH 9.4)",
    description:
      "Locking, a new role or a new employee link signs the account out everywhere. Unlocking gives the old role back.",
  })
  @ApiOkResponse({ type: AccountView })
  @ApiBadRequestResponse({ type: ErrorBody, description: "ROLE_NEEDS_EMPLOYEE" })
  @ApiNotFoundResponse({ type: ErrorBody, description: "USER_NOT_FOUND, EMPLOYEE_NOT_FOUND" })
  @ApiConflictResponse({
    type: ErrorBody,
    description: "LAST_ADMIN, EMPLOYEE_HAS_LEFT, EMAIL_ALREADY_HAS_ACCOUNT, EMPLOYEE_HAS_ACCOUNT",
  })
  update(
    @Param("id") id: string,
    @Body() body: UpdateUserDto,
    @Req() req: Request,
  ): Promise<AccountView> {
    return this.users.update(actorOf(req), id, body);
  }

  @Delete(":id")
  @Roles("ADMIN")
  @AuditedInService()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: "Delete an account nobody ever set a password for",
    description: "An account with a history is locked with PATCH {active:false}, so the audit trail keeps its actor.",
  })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ type: ErrorBody, description: "USER_NOT_FOUND" })
  @ApiConflictResponse({ type: ErrorBody, description: "ACCOUNT_HAS_HISTORY" })
  remove(@Param("id") id: string, @Req() req: Request): Promise<void> {
    return this.users.remove(id, actorOf(req));
  }
}
