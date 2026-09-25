import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsEmail, IsEnum, IsInt, IsOptional, IsString, MaxLength } from "class-validator";

import { PageMeta, PersonView, QueueQueryDto } from "../../leave/dto/queue.dto.js";
import { PROFILE_FIELD_NAMES, type ProfileFieldName } from "../profile-fields.js";

const STATES = ["PENDING", "APPROVED", "REJECTED", "CANCELLED"] as const;
const EMAIL_MAX = 128;
const PHONE_MAX = 20;
const BANK_NAME_MAX = 64;
const BANK_ACCOUNT_MAX = 32;
const ID_MAX = 20;
const REASON_MAX = 500;

export class AskProfileChangeDto {
  @ApiProperty({ enum: PROFILE_FIELD_NAMES })
  @IsEnum(PROFILE_FIELD_NAMES)
  field!: ProfileFieldName;

  @ApiPropertyOptional({ description: "Whose record; the caller's own when left out" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  employeeId?: number;

  @ApiPropertyOptional({ example: "nv0002@example.com" })
  @IsOptional()
  @IsEmail()
  @MaxLength(EMAIL_MAX)
  personalEmail?: string;

  @ApiPropertyOptional({ maxLength: PHONE_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(PHONE_MAX)
  phone?: string;

  @ApiPropertyOptional({ maxLength: BANK_NAME_MAX, example: "Vietcombank" })
  @IsOptional()
  @IsString()
  @MaxLength(BANK_NAME_MAX)
  bankName?: string;

  @ApiPropertyOptional({ maxLength: BANK_ACCOUNT_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(BANK_ACCOUNT_MAX)
  bankAccount?: string;

  @ApiPropertyOptional({ maxLength: ID_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(ID_MAX)
  nationalId?: string;

  @ApiPropertyOptional({ maxLength: ID_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(ID_MAX)
  taxCode?: string;

  @ApiPropertyOptional({ maxLength: ID_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(ID_MAX)
  socialInsuranceNo?: string;

  @ApiPropertyOptional({ maxLength: REASON_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(REASON_MAX)
  reason?: string;
}

export class DecideProfileChangeDto {
  @ApiPropertyOptional({ maxLength: REASON_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(REASON_MAX)
  note?: string;
}

export class ListProfileChangesDto extends QueueQueryDto {
  @ApiPropertyOptional({ enum: STATES, description: "PENDING is the desk's queue, without its own rows" })
  @IsOptional()
  @IsEnum(STATES)
  state?: (typeof STATES)[number];

  @ApiPropertyOptional({ enum: PROFILE_FIELD_NAMES, description: "Which part of the record" })
  @IsOptional()
  @IsEnum(PROFILE_FIELD_NAMES)
  field?: ProfileFieldName;

  @ApiPropertyOptional({ description: "One person's changes, still inside what the viewer may see" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  employeeId?: number;
}

export class ProfileChangeView {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  employeeId!: number;

  @ApiProperty({ enum: PROFILE_FIELD_NAMES })
  field!: string;

  @ApiProperty({ type: Object, nullable: true, description: "The columns as they stood when asked" })
  oldValue!: Record<string, string | null> | null;

  @ApiProperty({ type: Object, description: "The columns asked for" })
  newValue!: Record<string, string | null>;

  @ApiProperty({ enum: STATES })
  state!: string;

  @ApiProperty({ nullable: true })
  reason!: string | null;

  @ApiProperty({ nullable: true })
  note!: string | null;

  @ApiProperty({ nullable: true })
  askedById!: string | null;

  @ApiProperty({ nullable: true })
  decidedAt!: Date | null;

  @ApiProperty()
  createdAt!: Date;
}

export class ProfileChangeRowView extends ProfileChangeView {
  @ApiProperty({ type: PersonView })
  employee!: PersonView;

  @ApiProperty({ description: "Whole days since it was asked for" })
  waitedDays!: number;
}

export class ProfileChangePageView extends PageMeta {
  @ApiProperty({ type: [ProfileChangeRowView] })
  rows!: ProfileChangeRowView[];
}
