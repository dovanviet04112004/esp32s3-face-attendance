import { ApiProperty, ApiPropertyOptional, PartialType } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

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
}

export class UpdateEmployeeDto extends PartialType(CreateEmployeeDto) {
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
