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
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request } from "express";

import { Roles } from "../../common/decorators/roles.decorator.js";
import type { Page, PaginationDto } from "../../common/dto/pagination.dto.js";
import { PaginationDto as Pagination } from "../../common/dto/pagination.dto.js";
import { JwtAuthGuard } from "../../common/guards/jwt-auth.guard.js";
import { RolesGuard } from "../../common/guards/roles.guard.js";
import type { AccessClaims } from "../auth/auth.types.js";
import { CreateUserDto, UpdateUserDto } from "./dto/user.dto.js";
import { UsersService, type PublicUser } from "./users.service.js";

@ApiTags("users")
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles("ADMIN")
@Controller("users")
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiOperation({ summary: "List accounts; a password hash never leaves here" })
  list(@Query() query: Pagination): Promise<Page<PublicUser>> {
    return this.users.list(query as PaginationDto);
  }

  @Post()
  create(@Body() body: CreateUserDto): Promise<PublicUser> {
    return this.users.create(body);
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() body: UpdateUserDto): Promise<PublicUser> {
    return this.users.update(id, body);
  }

  @Delete(":id")
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: "Remove an account, never the last administrator" })
  remove(@Param("id") id: string, @Req() req: Request): Promise<void> {
    return this.users.remove(id, (req.user as AccessClaims).sub);
  }
}
