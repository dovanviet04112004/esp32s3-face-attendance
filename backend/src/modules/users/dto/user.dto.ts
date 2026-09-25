import { ApiProperty, ApiPropertyOptional, IntersectionType } from "@nestjs/swagger";
import { Role } from "@prisma/client";
import { Type } from "class-transformer";
import { IsBoolean, IsEmail, IsEnum, IsIn, IsInt, IsOptional, IsString, MaxLength } from "class-validator";

import { PaginationDto } from "../../../common/dto/pagination.dto.js";

const EMAIL_MAX = 128;
const SEARCH_MAX = 64;
const ID_MAX = 64;

export const ACCOUNT_STATUSES = ["active", "locked", "pending"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export class CreateUserDto {
  @ApiProperty({ example: "hr@kiosk.local", maxLength: EMAIL_MAX })
  @IsEmail()
  @MaxLength(EMAIL_MAX)
  email!: string;

  @ApiProperty({
    enum: Role,
    description: "EMPLOYEE, MANAGER and PAYROLL need employeeId; EMPLOYEE and MANAGER settle on whichever the org tree says",
  })
  @IsEnum(Role)
  role!: Role;

  @ApiPropertyOptional({ description: "The employee record this login acts as" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  employeeId?: number;
}

export class UpdateUserDto {
  @ApiPropertyOptional({ maxLength: EMAIL_MAX })
  @IsOptional()
  @IsEmail()
  @MaxLength(EMAIL_MAX)
  email?: string;

  @ApiPropertyOptional({ enum: Role })
  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  @ApiPropertyOptional({ description: "false locks the account and signs it out everywhere; true unlocks it" })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({ type: Number, nullable: true, description: "null unlinks the employee record" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  employeeId?: number | null;
}

export class UserFilterDto {
  @ApiPropertyOptional({ description: "Matches the email, or the linked employee's code or full name", maxLength: SEARCH_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(SEARCH_MAX)
  search?: string;

  @ApiPropertyOptional({ enum: Role, description: "Accounts holding this role only" })
  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  @ApiPropertyOptional({ description: "The department and its whole subtree", maxLength: ID_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(ID_MAX)
  departmentId?: string;

  @ApiPropertyOptional({ enum: ACCOUNT_STATUSES, description: "pending: no password set yet" })
  @IsOptional()
  @IsIn(ACCOUNT_STATUSES)
  status?: AccountStatus;
}

export class ListUsersDto extends IntersectionType(PaginationDto, UserFilterDto) {}

export class AccountDepartmentView {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;
}

export class AccountEmployeeView {
  @ApiProperty()
  id!: number;

  @ApiProperty()
  code!: string;

  @ApiProperty()
  fullName!: string;

  @ApiProperty({ type: AccountDepartmentView, nullable: true })
  department!: AccountDepartmentView | null;
}

export class AccountView {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  email!: string;

  @ApiProperty({ enum: Role })
  role!: Role;

  @ApiProperty({ description: "false: locked" })
  active!: boolean;

  @ApiProperty({ description: "No password set yet: the setup link is still waiting" })
  pending!: boolean;

  @ApiProperty({ type: String, format: "date-time", nullable: true, description: "Latest sign-in or token renewal" })
  lastSeenAt!: Date | null;

  @ApiProperty({ type: String, format: "date-time" })
  createdAt!: Date;

  @ApiProperty({ type: AccountEmployeeView, nullable: true })
  employee!: AccountEmployeeView | null;
}

export class AccountPage {
  @ApiProperty({ type: [AccountView] })
  rows!: AccountView[];

  @ApiProperty()
  total!: number;

  @ApiProperty({ description: "false when counting stopped at the ceiling (KEHOACH 9.9)" })
  totalIsExact!: boolean;

  @ApiProperty({ type: String, nullable: true, description: "Pass back as cursor for the next page" })
  next!: string | null;
}

export class AccountStatusCounts {
  @ApiProperty()
  active!: number;

  @ApiProperty()
  locked!: number;

  @ApiProperty()
  pending!: number;
}

export class AccountCounts {
  @ApiProperty({
    type: "object",
    additionalProperties: { type: "number" },
    description: "Every role, under the other filters",
    example: { ADMIN: 1, HR: 2, PAYROLL: 1, MANAGER: 4, EMPLOYEE: 40, VIEWER: 0 },
  })
  byRole!: Record<Role, number>;

  @ApiProperty({ type: AccountStatusCounts, description: "Every status, under the other filters" })
  byStatus!: AccountStatusCounts;
}

export class MeView {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  email!: string;

  @ApiProperty({ enum: Role })
  role!: Role;

  @ApiProperty({ type: AccountEmployeeView, nullable: true })
  employee!: AccountEmployeeView | null;
}

export class LoginOpenedView {
  @ApiProperty({ enum: ["opened", "resent"] })
  state!: "opened" | "resent";
}

export const LOGIN_STATES = ["none", "pending", "active", "locked"] as const;

export class LoginStateView {
  @ApiProperty({ enum: LOGIN_STATES })
  state!: (typeof LOGIN_STATES)[number];

  @ApiProperty({ type: String, nullable: true })
  email!: string | null;

  @ApiProperty({ enum: Role, nullable: true })
  role!: Role | null;

  @ApiProperty({ type: String, format: "date-time", nullable: true })
  lastSeenAt!: Date | null;

  @ApiProperty({ description: "Whether the record holds an address a link can go to" })
  hasEmail!: boolean;
}
