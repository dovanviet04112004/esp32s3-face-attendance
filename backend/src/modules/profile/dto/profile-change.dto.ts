import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsEmail, IsEnum, IsInt, IsOptional, IsString, MaxLength } from "class-validator";

import { PaginationDto } from "../../../common/dto/pagination.dto.js";
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

export class ListProfileChangesDto extends PaginationDto {
  @ApiPropertyOptional({ enum: STATES })
  @IsOptional()
  @IsEnum(STATES)
  state?: (typeof STATES)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  employeeId?: number;
}
