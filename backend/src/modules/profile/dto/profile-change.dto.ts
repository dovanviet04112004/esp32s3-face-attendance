import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsEmail, IsEnum, IsInt, IsOptional, IsString, Matches, MaxLength } from "class-validator";

import { BANK_ACCOUNT, EMPLOYEE_FIELD_MAX, PLAIN_TEXT } from "../../employees/import.js";
import { PageMeta, PersonView, QueueQueryDto } from "../../leave/dto/queue.dto.js";
import { PROFILE_FIELD_NAMES, type ProfileFieldName } from "../profile-fields.js";

const STATES = ["PENDING", "APPROVED", "REJECTED", "CANCELLED"] as const;
const EMAIL_MAX = 128;
const PHONE_MAX = 20;
const BANK_NAME_MAX = 64;
const ID_MAX = 20;
const REASON_MAX = 500;

export class AskProfileChangeDto {
  @ApiProperty({
    enum: PROFILE_FIELD_NAMES,
    enumName: "ProfileField",
    description: "Which part of the record to change; BANK takes bankName and bankAccount together",
    example: "BANK",
  })
  @IsEnum(PROFILE_FIELD_NAMES)
  field!: ProfileFieldName;

  @ApiPropertyOptional({ description: "Whose record; the caller's own when left out", example: 42 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  employeeId?: number;

  @ApiPropertyOptional({
    maxLength: EMAIL_MAX,
    description: "New personal email; read only when field is PERSONAL_EMAIL",
    example: "nv0002@example.com",
  })
  @IsOptional()
  @IsEmail()
  @MaxLength(EMAIL_MAX)
  personalEmail?: string;

  @ApiPropertyOptional({ maxLength: PHONE_MAX, description: "New phone number; read only when field is PHONE", example: "0912345678" })
  @IsOptional()
  @IsString()
  @MaxLength(PHONE_MAX)
  phone?: string;

  @ApiPropertyOptional({
    maxLength: BANK_NAME_MAX,
    description: "Bank of the new salary account, no leading = + - @ and no line break; read only when field is BANK",
    example: "Vietcombank",
  })
  @IsOptional()
  @IsString()
  @MaxLength(BANK_NAME_MAX)
  @Matches(PLAIN_TEXT)
  bankName?: string;

  @ApiPropertyOptional({
    maxLength: EMPLOYEE_FIELD_MAX.bankAccount,
    description: "New salary account number, letters and digits only; read only when field is BANK",
    example: "0071000123456",
  })
  @IsOptional()
  @IsString()
  @MaxLength(EMPLOYEE_FIELD_MAX.bankAccount)
  @Matches(BANK_ACCOUNT)
  bankAccount?: string;

  @ApiPropertyOptional({
    maxLength: ID_MAX,
    description: "New citizen identity number; read only when field is NATIONAL_ID",
    example: "001095012345",
  })
  @IsOptional()
  @IsString()
  @MaxLength(ID_MAX)
  nationalId?: string;

  @ApiPropertyOptional({ maxLength: ID_MAX, description: "New personal tax code; read only when field is TAX_CODE", example: "8012345678" })
  @IsOptional()
  @IsString()
  @MaxLength(ID_MAX)
  taxCode?: string;

  @ApiPropertyOptional({
    maxLength: ID_MAX,
    description: "New social insurance number; read only when field is SOCIAL_INSURANCE_NO",
    example: "0123456789",
  })
  @IsOptional()
  @IsString()
  @MaxLength(ID_MAX)
  socialInsuranceNo?: string;

  @ApiPropertyOptional({
    maxLength: REASON_MAX,
    description: "Why the change is asked for; the decider reads it",
    example: "Chuyển sang tài khoản lương mới",
  })
  @IsOptional()
  @IsString()
  @MaxLength(REASON_MAX)
  reason?: string;
}

export class DecideProfileChangeDto {
  @ApiPropertyOptional({
    maxLength: REASON_MAX,
    description: "Why it was turned down; the asker reads it",
    example: "Tên chủ tài khoản không khớp hồ sơ",
  })
  @IsOptional()
  @IsString()
  @MaxLength(REASON_MAX)
  note?: string;
}

export class ListProfileChangesDto extends QueueQueryDto {
  @ApiPropertyOptional({
    enum: STATES,
    enumName: "ProfileChangeState",
    description: "PENDING is the desk's queue, without its own rows",
  })
  @IsOptional()
  @IsEnum(STATES)
  state?: (typeof STATES)[number];

  @ApiPropertyOptional({ enum: PROFILE_FIELD_NAMES, enumName: "ProfileField", description: "Which part of the record" })
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
  @ApiProperty({ description: "Change request id", example: "0f1a2b3c-4d5e-4f6a-9b7c-8d9e0f1a2b3c" })
  id!: string;

  @ApiProperty({ description: "Employee whose record it changes", example: 42 })
  employeeId!: number;

  @ApiProperty({ enum: PROFILE_FIELD_NAMES, enumName: "ProfileField", description: "Which part of the record" })
  field!: string;

  @ApiProperty({
    type: Object,
    nullable: true,
    description: "The columns as they stood when asked",
    example: { bankName: "Vietcombank", bankAccount: "0071000123456" },
  })
  oldValue!: Record<string, string | null> | null;

  @ApiProperty({
    type: Object,
    description: "The columns asked for",
    example: { bankName: "Techcombank", bankAccount: "19033344455566" },
  })
  newValue!: Record<string, string | null>;

  @ApiProperty({
    enum: STATES,
    enumName: "ProfileChangeState",
    description: "Waiting, written into the record, turned down, or taken back",
  })
  state!: string;

  @ApiProperty({ type: String, nullable: true, description: "Why the asker wants it" })
  reason!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: "Where the approval warning goes, captured when the change was asked; null for a field that warns nobody",
    example: "tran.thi.b@example.com",
  })
  noticeTo!: string | null;

  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    description: "When the warning mail went out; null until then",
    example: "2026-09-21T02:05:00.000Z",
  })
  noticeSentAt!: Date | null;

  @ApiProperty({ type: String, nullable: true, description: "Why it was turned down; null otherwise" })
  note!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: "Account that asked; null once that account is deleted",
    example: "b5f0c3d2-8a41-4e6b-9c2d-7f1e3a5b9c04",
  })
  askedById!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: "Account that approved or turned it down; null while it waits or once taken back",
    example: "c6a1d4e3-9b52-4f7c-8d3e-0a2b4c6d8e1f",
  })
  decidedById!: string | null;

  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    description: "When it was approved, turned down or taken back; null while it waits",
    example: "2026-09-21T02:04:30.000Z",
  })
  decidedAt!: Date | null;

  @ApiProperty({ type: String, format: "date-time", description: "When it was asked for", example: "2026-09-20T09:12:00.000Z" })
  createdAt!: Date;

  @ApiProperty({ type: String, format: "date-time", description: "Last change to the row", example: "2026-09-21T02:05:00.000Z" })
  updatedAt!: Date;
}

export class ProfileChangeRowView extends ProfileChangeView {
  @ApiProperty({ type: PersonView, description: "Whose record it is, with their department" })
  employee!: PersonView;

  @ApiProperty({ description: "Whole days since it was asked for", example: 1 })
  waitedDays!: number;
}

export class ProfileChangePageView extends PageMeta {
  @ApiProperty({
    type: [ProfileChangeRowView],
    description: "One page of changes by asking time: oldest first for PENDING, newest first otherwise, unless order says",
  })
  rows!: ProfileChangeRowView[];
}
