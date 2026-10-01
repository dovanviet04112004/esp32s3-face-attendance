import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsOptional, IsString, Matches, MaxLength } from "class-validator";

import { PaginationDto } from "../../../common/dto/pagination.dto.js";
import { AUDIT_ACTIONS, AUDIT_SUBJECTS, type AuditAction, type AuditSubject } from "../audit-actions.js";

const SUBJECTS = Object.values(AUDIT_SUBJECTS);
const ACTIONS = Object.values(AUDIT_ACTIONS);
const ID_MAX = 128;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export class AuditQueryDto extends PaginationDto {
  @ApiPropertyOptional({
    enum: SUBJECTS,
    enumName: "AuditSubject",
    description: "Only entries about this kind of thing",
  })
  @IsOptional()
  @IsIn(SUBJECTS)
  subjectType?: AuditSubject;

  @ApiPropertyOptional({
    example: "412",
    description: "Only entries about this one thing; an employee id is a number as text",
  })
  @IsOptional()
  @IsString()
  @MaxLength(ID_MAX)
  subjectId?: string;

  @ApiPropertyOptional({ description: "The account that acted" })
  @IsOptional()
  @IsString()
  @MaxLength(ID_MAX)
  actorId?: string;

  @ApiPropertyOptional({ enum: ACTIONS, enumName: "AuditAction", description: "Only entries of this action" })
  @IsOptional()
  @IsIn(ACTIONS)
  action?: AuditAction;

  @ApiPropertyOptional({ example: "2026-09-01", description: "First day, in the business time zone" })
  @IsOptional()
  @Matches(ISO_DAY)
  from?: string;

  @ApiPropertyOptional({ example: "2026-09-30", description: "Last day, included, in the business time zone" })
  @IsOptional()
  @Matches(ISO_DAY)
  to?: string;
}

class AuditActorPersonView {
  @ApiProperty({ example: "NV0010", description: "Employee code of the person behind the account" })
  code!: string;

  @ApiProperty({ example: "Lê Thị Nhân Sự", description: "Name of the person behind the account" })
  fullName!: string;
}

class AuditActorView {
  @ApiProperty({ example: "hr@kiosk.local", description: "Sign-in email of the account that acted" })
  email!: string;

  @ApiProperty({
    type: AuditActorPersonView,
    nullable: true,
    description: "The employee behind the account; null for an account without one",
  })
  employee!: AuditActorPersonView | null;
}

export class AuditRowView {
  @ApiProperty({ type: String, example: "90211", description: "BigInt as a string" })
  id!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: "ab35f74f-dd47-4ad6-8e4c-fb243e7ac176",
    description: "Account that acted; null for a kiosk, the system or a deleted account",
  })
  actorId!: string | null;

  @ApiProperty({ enum: ACTIONS, enumName: "AuditAction", example: "employee.update", description: "What was done" })
  action!: string;

  @ApiProperty({
    enum: SUBJECTS,
    enumName: "AuditSubject",
    example: "employee",
    description: "Kind of thing it was done to",
  })
  subjectType!: string;

  @ApiProperty({ example: "412", description: "Id of the thing, as text whatever its own type" })
  subjectId!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: "NV0412 · Trần Thị Bình",
    description: "Code and name of an employee subject, email of a user subject",
  })
  subjectName!: string | null;

  @ApiProperty({
    type: "object",
    nullable: true,
    additionalProperties: true,
    example: { fields: ["departmentId", "phone"] },
    description: "What moved, in a shape each action sets; null when the action records nothing more",
  })
  meta!: unknown;

  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-09-25T03:41:10.000Z",
    description: "When it happened",
  })
  ts!: Date;

  @ApiProperty({ type: AuditActorView, nullable: true, description: "Who acted; null when actorId is" })
  actor!: AuditActorView | null;
}

export class AuditVocabularyView {
  @ApiProperty({
    type: [String],
    example: ["employee.create", "user.role"],
    description: "Every action name an entry may carry",
  })
  actions!: string[];

  @ApiProperty({ type: [String], example: ["employee", "user"], description: "Every subject kind an entry may name" })
  subjects!: string[];
}

export class AuditPageView {
  @ApiProperty({ type: [AuditRowView], description: "Newest first" })
  rows!: AuditRowView[];

  @ApiProperty({ example: 2480, description: "Entries the filter reaches, counted no further than the ceiling" })
  total!: number;

  @ApiProperty({ example: true, description: "False when counting stopped at the ceiling, so total is a floor" })
  totalIsExact!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    example: "eyJzb3J0VmFsdWUiOiIyMDI2LTA5LTE0VDAxOjMyOjA1LjAwMFoiLCJpZCI6IjE4NDIifQ",
    description: "Cursor for the next page, sent back as cursor; null once a page comes back short",
  })
  next!: string | null;
}
