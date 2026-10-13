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
  ApiParam,
  ApiTags,
} from "@nestjs/swagger";

import { ApiErrors } from "../../common/decorators/api-docs.decorator.js";
import { AuditedInService } from "../../common/decorators/audited.decorator.js";
import { RateBucket } from "../../common/decorators/rate-bucket.decorator.js";
import { Roles } from "../../common/decorators/roles.decorator.js";
import { ErrorBody } from "../../common/dto/error-body.dto.js";
import type { Page } from "../../common/dto/pagination.dto.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import { CurrentViewer, type Viewer } from "../../common/scope/viewer.js";
import { THROTTLE } from "../auth/auth.types.js";
import {
  AccountCounts,
  AccountPage,
  AccountView,
  CreateUserDto,
  ListUsersDto,
  MeView,
  ProvisioningView,
  UpdateUserDto,
  UserFilterDto,
} from "./dto/user.dto.js";
import { UsersService, type Provisioning } from "./users.service.js";

const ACCOUNT_ID = { name: "id", description: "Account id", example: "b5f0c3d2-8a41-4e6b-9c2d-7f1e3a5b9c04" };

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
  @RateBucket(THROTTLE.heavy)
  @Roles("ADMIN")
  @ApiOperation({ summary: "Open a login for employees who have none (KEHOACH 9.4)" })
  @ApiCreatedResponse({ type: ProvisioningView })
  provision(): Promise<Provisioning> {
    return this.users.provision();
  }

  @Post()
  @Roles("ADMIN")
  @AuditedInService()
  @ApiOperation({ summary: "Open a login with any of the six roles and mail its one-time setup link" })
  @ApiCreatedResponse({ type: AccountView })
  @ApiBadRequestResponse({
    type: ErrorBody,
    description:
      "ROLE_NEEDS_EMPLOYEE: EMPLOYEE and MANAGER need employeeId; DESK_NEEDS_EMPLOYEE: so do HR and PAYROLL; ENTITIES_NEED_DESK: only HR and PAYROLL answer for some entities",
  })
  @ApiNotFoundResponse({ type: ErrorBody, description: "EMPLOYEE_NOT_FOUND, LEGAL_ENTITY_NOT_FOUND" })
  @ApiConflictResponse({ type: ErrorBody, description: "EMAIL_ALREADY_HAS_ACCOUNT, EMPLOYEE_HAS_ACCOUNT, EMPLOYEE_HAS_LEFT" })
  create(@Body() body: CreateUserDto, @CurrentViewer() viewer: Viewer): Promise<AccountView> {
    return this.users.create(viewer.userId, body);
  }

  @Post(":id/invite")
  @RateBucket(THROTTLE.heavy)
  @Roles("ADMIN")
  @AuditedInService()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Mail the setup link again, for a password nobody can recall" })
  @ApiParam(ACCOUNT_ID)
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ type: ErrorBody, description: "USER_NOT_FOUND, also for a locked account" })
  invite(@Param("id") id: string, @CurrentViewer() viewer: Viewer): Promise<void> {
    return this.users.invite(viewer.userId, id);
  }

  @Patch(":id")
  @Roles("ADMIN")
  @AuditedInService()
  @ApiOperation({
    summary: "Change role, lock or unlock, address, linked employee or the entities a desk answers for (KEHOACH 9.4)",
    description:
      "Locking, a new role, a new employee link or a new list of entities signs the account out everywhere. Unlocking gives the old role back.",
  })
  @ApiParam(ACCOUNT_ID)
  @ApiOkResponse({ type: AccountView })
  @ApiBadRequestResponse({ type: ErrorBody, description: "ROLE_NEEDS_EMPLOYEE, DESK_NEEDS_EMPLOYEE, ENTITIES_NEED_DESK" })
  @ApiNotFoundResponse({ type: ErrorBody, description: "USER_NOT_FOUND, EMPLOYEE_NOT_FOUND, LEGAL_ENTITY_NOT_FOUND" })
  @ApiConflictResponse({
    type: ErrorBody,
    description: "LAST_ADMIN, EMPLOYEE_HAS_LEFT, EMAIL_ALREADY_HAS_ACCOUNT, EMPLOYEE_HAS_ACCOUNT",
  })
  update(
    @Param("id") id: string,
    @Body() body: UpdateUserDto,
    @CurrentViewer() viewer: Viewer,
  ): Promise<AccountView> {
    return this.users.update(viewer.userId, id, body);
  }

  @Delete(":id")
  @Roles("ADMIN")
  @AuditedInService()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: "Delete an account nobody ever set a password for",
    description: "An account with a history is locked with PATCH {active:false}, so the audit trail keeps its actor.",
  })
  @ApiParam(ACCOUNT_ID)
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ type: ErrorBody, description: "USER_NOT_FOUND" })
  @ApiConflictResponse({ type: ErrorBody, description: "ACCOUNT_HAS_HISTORY" })
  remove(@Param("id") id: string, @CurrentViewer() viewer: Viewer): Promise<void> {
    return this.users.remove(id, viewer.userId);
  }

  @Delete(":id/mfa")
  @Roles("ADMIN")
  @AuditedInService()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: "Reset another account's two-step sign-in",
    description:
      "Drops its authenticator and backup codes and signs it out everywhere; its next sign-in links an app again. Nobody resets their own (KEHOACH 9.4).",
  })
  @ApiParam(ACCOUNT_ID)
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ type: ErrorBody, description: "USER_NOT_FOUND" })
  @ApiConflictResponse({ type: ErrorBody, description: "MFA_NOT_ON: the account has no authenticator to reset" })
  resetMfa(@Param("id") id: string, @CurrentViewer() viewer: Viewer): Promise<void> {
    return this.users.resetMfa(viewer.userId, id);
  }
}
