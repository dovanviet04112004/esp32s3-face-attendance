import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsOptional, IsString, Matches, MaxLength } from "class-validator";

import { PaginationDto } from "../../../common/dto/pagination.dto.js";
import { AUDIT_ACTIONS, AUDIT_SUBJECTS, type AuditAction, type AuditSubject } from "../audit-actions.js";

const SUBJECTS = Object.values(AUDIT_SUBJECTS);
const ACTIONS = Object.values(AUDIT_ACTIONS);
const ID_MAX = 128;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

export class AuditQueryDto extends PaginationDto {
  @ApiPropertyOptional({ enum: SUBJECTS })
  @IsOptional()
  @IsIn(SUBJECTS)
  subjectType?: AuditSubject;

  @ApiPropertyOptional({ example: "412" })
  @IsOptional()
  @IsString()
  @MaxLength(ID_MAX)
  subjectId?: string;

  @ApiPropertyOptional({ description: "The account that acted" })
  @IsOptional()
  @IsString()
  @MaxLength(ID_MAX)
  actorId?: string;

  @ApiPropertyOptional({ enum: ACTIONS })
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
  @ApiProperty()
  code!: string;

  @ApiProperty()
  fullName!: string;
}

class AuditActorView {
  @ApiProperty()
  email!: string;

  @ApiProperty({ type: AuditActorPersonView, nullable: true })
  employee!: AuditActorPersonView | null;
}

export class AuditRowView {
  @ApiProperty({ type: String, description: "BigInt as a string" })
  id!: string;

  @ApiProperty({ type: String, nullable: true })
  actorId!: string | null;

  @ApiProperty({ enum: ACTIONS })
  action!: string;

  @ApiProperty({ enum: SUBJECTS })
  subjectType!: string;

  @ApiProperty()
  subjectId!: string;

  @ApiProperty({ type: String, nullable: true, description: "Code and name of an employee subject, email of a user subject" })
  subjectName!: string | null;

  @ApiProperty({ type: "object", nullable: true, additionalProperties: true })
  meta!: unknown;

  @ApiProperty({ type: String, format: "date-time" })
  ts!: Date;

  @ApiProperty({ type: AuditActorView, nullable: true })
  actor!: AuditActorView | null;
}

export class AuditVocabularyView {
  @ApiProperty({ type: [String], example: ["employee.create", "user.role"] })
  actions!: string[];

  @ApiProperty({ type: [String], example: ["employee", "user"] })
  subjects!: string[];
}

export class AuditPageView {
  @ApiProperty({ type: [AuditRowView] })
  rows!: AuditRowView[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  totalIsExact!: boolean;

  @ApiProperty({ type: String, nullable: true })
  next!: string | null;
}
