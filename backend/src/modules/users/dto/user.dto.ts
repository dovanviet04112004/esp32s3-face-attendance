import { ApiProperty, ApiPropertyOptional, PartialType } from "@nestjs/swagger";
import { Role } from "@prisma/client";
import { IsEmail, IsEnum, IsOptional } from "class-validator";

import { PaginationDto } from "../../../common/dto/pagination.dto.js";

const ROLES = ["ADMIN", "HR", "VIEWER"] as const;

export class CreateUserDto {
  @ApiProperty({ example: "hr@kiosk.local" })
  @IsEmail()
  email!: string;

  @ApiProperty({ enum: ROLES })
  @IsEnum(ROLES)
  role!: (typeof ROLES)[number];
}

export class UpdateUserDto extends PartialType(CreateUserDto) {
  @ApiPropertyOptional({ enum: ROLES })
  @IsOptional()
  @IsEnum(ROLES)
  role?: (typeof ROLES)[number];
}

export class ListUsersDto extends PaginationDto {
  @ApiPropertyOptional({ enum: Role, description: "Accounts holding this role only" })
  @IsOptional()
  @IsEnum(Role)
  role?: Role;
}
