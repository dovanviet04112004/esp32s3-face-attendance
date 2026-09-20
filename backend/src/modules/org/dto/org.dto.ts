import { ApiProperty, ApiPropertyOptional, PartialType } from "@nestjs/swagger";
import { ContractKind, ContractState } from "@prisma/client";
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";

export class CreateDepartmentDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  legalEntityId!: string;

  @ApiProperty({ example: "PB0001", maxLength: 32 })
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  code!: string;

  @ApiProperty({ example: "Kỹ thuật", maxLength: 128 })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name!: string;

  @ApiPropertyOptional({ description: "Null for a top-level department" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  parentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(32)
  costCentre?: string;

  @ApiPropertyOptional({ description: "Employee id of the person heading it" })
  @IsOptional()
  @IsInt()
  headId?: number;
}

export class UpdateDepartmentDto extends PartialType(CreateDepartmentDto) {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class CreateContractDto {
  @ApiProperty({ example: 1 })
  @IsInt()
  @Min(1)
  employeeId!: number;

  @ApiProperty({ enum: ContractKind })
  @IsEnum(ContractKind)
  kind!: ContractKind;

  @ApiPropertyOptional({ example: "HD-2026-001" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  number?: string;

  @ApiProperty({ example: "2026-01-01" })
  @IsDateString()
  startDate!: string;

  @ApiPropertyOptional({ example: "2027-01-01", description: "Null for an indefinite term" })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({ example: "2026-03-01" })
  @IsOptional()
  @IsDateString()
  probationEnd?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class DecideContractDto {
  @ApiProperty({ enum: ContractState })
  @IsEnum(ContractState)
  state!: ContractState;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
