import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from "@nestjs/swagger";
import { ContractKind, Gender } from "@prisma/client";

import { IMPORT_MAX_BYTES } from "../import.js";
import { Transform, Type } from "class-transformer";
import {
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
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

/** Where the pay goes, and the address that hears of a change to it, are set when the record
 *  opens and move only through an approval afterwards (KEHOACH 9.18 rules 1 and 3).
 */
export class UpdateEmployeeDto extends OmitType(PartialType(CreateEmployeeDto), [
  "bankAccount",
  "bankName",
  "personalEmail",
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

  // Boolean("false") is true, so a query string has to be compared, not cast.
  @ApiPropertyOptional({ description: "true for people still working, false for those who left" })
  @IsOptional()
  @Transform(({ value }) => value === true || value === "true")
  @IsBoolean()
  active?: boolean;
}

export class ImportCsvDto {
  @ApiProperty({ description: "The whole file, as text" })
  @IsString()
  @MaxLength(IMPORT_MAX_BYTES)
  csv!: string;
}

export class OnboardContractDto {
  @ApiProperty({ enum: ContractKind, example: ContractKind.PROBATION })
  @IsEnum(ContractKind)
  kind!: ContractKind;

  @ApiProperty({ example: "2026-10-01", description: "Their first day; leave is prorated from it" })
  @IsDateString()
  startDate!: string;

  @ApiPropertyOptional({ description: "Absent means indefinite (KEHOACH 9.18)" })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  probationEnd?: string;

  @ApiPropertyOptional({ maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  number?: string;
}

export class OnboardPayDto {
  @ApiProperty({ example: 15_000_000 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  baseSalary!: number;

  @ApiProperty({ example: 15_000_000, description: "What insurance is charged on (KEHOACH 9.6)" })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  insuranceSalary!: number;
}

export class OnboardDto {
  @ApiProperty({ type: OnboardContractDto })
  @ValidateNested()
  @Type(() => OnboardContractDto)
  contract!: OnboardContractDto;

  @ApiPropertyOptional({ type: OnboardPayDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => OnboardPayDto)
  pay?: OnboardPayDto;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  seedLeave?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  startChecklist?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  openLogin?: boolean;
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
