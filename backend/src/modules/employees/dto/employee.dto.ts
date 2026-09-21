import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from "@nestjs/swagger";
import { Gender } from "@prisma/client";

import { IMPORT_MAX_BYTES } from "../import.js";
import { Type } from "class-transformer";
import {
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator";

import { PaginationDto } from "../../../common/dto/pagination.dto.js";

export class CreateEmployeeDto {
  @ApiProperty({ example: "NV0002", maxLength: 32 })
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  code!: string;

  @ApiProperty({ example: "Trần Thị B", maxLength: 64 })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  fullName!: string;

  @ApiPropertyOptional({ description: "Department id, from the org tree (KEHOACH 9.3)" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  departmentId?: string;

  @ApiPropertyOptional({ description: "Which legal entity employs them (KEHOACH 9.20)" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  legalEntityId?: string;

  @ApiPropertyOptional({ description: "Who approves this person's requests" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  managerId?: number;

  @ApiPropertyOptional({ example: "nv0002@example.com" })
  @IsOptional()
  @IsEmail()
  @MaxLength(128)
  personalEmail?: string;

  @ApiPropertyOptional({ maxLength: 20 })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  phone?: string;

  @ApiPropertyOptional({ description: "Joined on; leave blank if unknown" })
  @IsOptional()
  @IsDateString()
  hireDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  dateOfBirth?: string;

  @ApiPropertyOptional({ enum: Gender })
  @IsOptional()
  @IsEnum(Gender)
  gender?: Gender;

  @ApiPropertyOptional({ maxLength: 20 })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  nationalId?: string;

  @ApiPropertyOptional({ maxLength: 20 })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  taxCode?: string;

  @ApiPropertyOptional({ description: "Needed by the D02-LT filing (KEHOACH 9.19)", maxLength: 20 })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  socialInsuranceNo?: string;

  @ApiPropertyOptional({ maxLength: 32 })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  bankAccount?: string;

  @ApiPropertyOptional({ maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  bankName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  jobTitleId?: string;
}

/** Where the pay goes is set when the record opens and moves only through an
 *  approval afterwards, so it has no column here (KEHOACH 9.17 item 6 rule 1).
 */
export class UpdateEmployeeDto extends OmitType(PartialType(CreateEmployeeDto), [
  "bankAccount",
  "bankName",
] as const) {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  active?: boolean;
}

export class ListEmployeesDto extends PaginationDto {
  @ApiPropertyOptional({ description: "Matches code or full name" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  search?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  departmentId?: string;
}

export class ImportCsvDto {
  @ApiProperty({ description: "The whole file, as text" })
  @IsString()
  @MaxLength(IMPORT_MAX_BYTES)
  csv!: string;
}

export class OffboardDto {
  @ApiProperty({ example: "2026-10-31", description: "Their last day" })
  @IsDateString()
  leaveDate!: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
