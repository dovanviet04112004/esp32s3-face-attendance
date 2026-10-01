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
  @ApiProperty({ description: "Sign-in address; the setup link is mailed there", example: "hr@kiosk.local", maxLength: EMAIL_MAX })
  @IsEmail()
  @MaxLength(EMAIL_MAX)
  email!: string;

  @ApiProperty({
    enum: Role,
    enumName: "Role",
    description: "EMPLOYEE, MANAGER and PAYROLL need employeeId; EMPLOYEE and MANAGER settle on whichever the org tree says",
    example: Role.HR,
  })
  @IsEnum(Role)
  role!: Role;

  @ApiPropertyOptional({ description: "The employee record this login acts as", example: 42 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  employeeId?: number;
}

export class UpdateUserDto {
  @ApiPropertyOptional({ maxLength: EMAIL_MAX, description: "New sign-in address", example: "hr2@kiosk.local" })
  @IsOptional()
  @IsEmail()
  @MaxLength(EMAIL_MAX)
  email?: string;

  @ApiPropertyOptional({
    enum: Role,
    enumName: "Role",
    description: "New role; EMPLOYEE and MANAGER settle on whichever the org tree says",
    example: Role.PAYROLL,
  })
  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  @ApiPropertyOptional({ description: "false locks the account and signs it out everywhere; true unlocks it", example: false })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({ type: Number, nullable: true, description: "null unlinks the employee record", example: 42 })
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

  @ApiPropertyOptional({ enum: Role, enumName: "Role", description: "Accounts holding this role only" })
  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  @ApiPropertyOptional({ description: "The department and its whole subtree", maxLength: ID_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(ID_MAX)
  departmentId?: string;

  @ApiPropertyOptional({ enum: ACCOUNT_STATUSES, enumName: "AccountStatus", description: "pending: no password set yet" })
  @IsOptional()
  @IsIn(ACCOUNT_STATUSES)
  status?: AccountStatus;
}

export class ListUsersDto extends IntersectionType(PaginationDto, UserFilterDto) {}

export class AccountDepartmentView {
  @ApiProperty({ description: "Department id", example: "6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f" })
  id!: string;

  @ApiProperty({ description: "Name the tree shows", example: "Kỹ thuật" })
  name!: string;
}

export class AccountEmployeeView {
  @ApiProperty({ description: "Employee id", example: 42 })
  id!: number;

  @ApiProperty({ description: "Employee code", example: "NV0002" })
  code!: string;

  @ApiProperty({ description: "Name as on the employee record", example: "Trần Thị B" })
  fullName!: string;

  @ApiProperty({ type: AccountDepartmentView, nullable: true, description: "Department the person sits in, if any" })
  department!: AccountDepartmentView | null;
}

export class AccountView {
  @ApiProperty({ description: "Account id", example: "b5f0c3d2-8a41-4e6b-9c2d-7f1e3a5b9c04" })
  id!: string;

  @ApiProperty({ description: "Sign-in address", example: "tran.thi.b@example.com" })
  email!: string;

  @ApiProperty({ enum: Role, enumName: "Role", description: "What the account may do" })
  role!: Role;

  @ApiProperty({ description: "false: locked" })
  active!: boolean;

  @ApiProperty({ description: "No password set yet: the setup link is still waiting" })
  pending!: boolean;

  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    description: "Latest sign-in or token renewal",
    example: "2026-09-30T08:12:45.000Z",
  })
  lastSeenAt!: Date | null;

  @ApiProperty({ type: String, format: "date-time", description: "When the account was opened", example: "2026-03-02T01:00:00.000Z" })
  createdAt!: Date;

  @ApiProperty({
    type: AccountEmployeeView,
    nullable: true,
    description: "The employee record it acts as; null for an account linked to nobody",
  })
  employee!: AccountEmployeeView | null;
}

export class AccountPage {
  @ApiProperty({ type: [AccountView], description: "One page of accounts, by email" })
  rows!: AccountView[];

  @ApiProperty({ description: "Accounts matching the filters, counted up to the ceiling" })
  total!: number;

  @ApiProperty({ description: "false when counting stopped at the ceiling (KEHOACH 9.9)" })
  totalIsExact!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    description: "Pass back as cursor for the next page",
    example: "eyJzb3J0VmFsdWUiOiJ0cmFuLnRoaS5iQGV4YW1wbGUuY29tIiwiaWQiOiJiNWYwYzNkMi04YTQxLTRlNmItOWMyZC03ZjFlM2E1YjljMDQifQ",
  })
  next!: string | null;
}

export class AccountStatusCounts {
  @ApiProperty({ description: "Unlocked accounts with a password set" })
  active!: number;

  @ApiProperty({ description: "Accounts switched off" })
  locked!: number;

  @ApiProperty({ description: "Unlocked accounts whose password was never set" })
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

  @ApiProperty({
    type: AccountStatusCounts,
    description: "Every status, under the other filters",
    example: { active: 41, locked: 2, pending: 5 },
  })
  byStatus!: AccountStatusCounts;
}

export class MeView {
  @ApiProperty({ description: "Account id", example: "b5f0c3d2-8a41-4e6b-9c2d-7f1e3a5b9c04" })
  id!: string;

  @ApiProperty({ description: "Sign-in address", example: "tran.thi.b@example.com" })
  email!: string;

  @ApiProperty({ enum: Role, enumName: "Role", description: "What the account may do" })
  role!: Role;

  @ApiProperty({ type: AccountEmployeeView, nullable: true, description: "The employee record it acts as, if any" })
  employee!: AccountEmployeeView | null;
}

export class ProvisionedAccountView {
  @ApiProperty({ description: "Employee code of the person the login is for", example: "NV0002" })
  employeeCode!: string;

  @ApiProperty({ description: "Sign-in address, taken from their personal email", example: "tran.thi.b@example.com" })
  email!: string;

  @ApiProperty({ enum: Role, enumName: "Role", description: "MANAGER when anyone active reports to them, EMPLOYEE otherwise" })
  role!: string;
}

export class ProvisioningView {
  @ApiProperty({ type: [ProvisionedAccountView], description: "Logins this call opened, each mailed a setup link" })
  accounts!: ProvisionedAccountView[];

  @ApiProperty({ description: "People with an address and still no login; call again to open the next batch", example: 120 })
  waiting!: number;
}

export class LoginOpenedView {
  @ApiProperty({
    enum: ["opened", "resent"],
    enumName: "LoginOpenedState",
    description: "opened: a login was made and its setup link mailed; resent: the open login's link went out again",
  })
  state!: "opened" | "resent";
}

export const LOGIN_STATES = ["none", "pending", "active", "locked"] as const;

export class LoginStateView {
  @ApiProperty({
    enum: LOGIN_STATES,
    enumName: "LoginState",
    description: "none: no login; pending: password never set; active: in use; locked: switched off",
  })
  state!: (typeof LOGIN_STATES)[number];

  @ApiProperty({
    type: String,
    nullable: true,
    description: "Sign-in address of the login; null without one",
    example: "tran.thi.b@example.com",
  })
  email!: string | null;

  @ApiProperty({ enum: Role, enumName: "Role", nullable: true, description: "Role of the login; null without one" })
  role!: Role | null;

  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    description: "Latest sign-in or token renewal; null when never used",
    example: "2026-09-30T08:12:45.000Z",
  })
  lastSeenAt!: Date | null;

  @ApiProperty({ description: "Whether the record holds an address a link can go to" })
  hasEmail!: boolean;
}
