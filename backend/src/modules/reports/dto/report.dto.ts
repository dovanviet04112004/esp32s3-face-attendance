import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsDateString, IsOptional, IsString, MaxLength } from "class-validator";

import { PaginationDto } from "../../../common/dto/pagination.dto.js";

export class RangeDto {
  @ApiProperty({ example: "2026-09-01T00:00:00.000Z" })
  @IsDateString()
  from!: string;

  @ApiProperty({ example: "2026-09-30T23:59:59.000Z" })
  @IsDateString()
  to!: string;
}

/** The roll-up is one row per employee, so it pages like any long list. */
export class TallyRangeDto extends PaginationDto {
  @ApiProperty({ example: "2026-09-01T00:00:00.000Z" })
  @IsDateString()
  from!: string;

  @ApiProperty({ example: "2026-09-30T23:59:59.000Z" })
  @IsDateString()
  to!: string;

  @ApiPropertyOptional({ description: "Matches the full name" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  search?: string;
}

export class D02QueryDto {
  @ApiProperty({ description: "The entity the filing is for" })
  @IsString()
  @MaxLength(64)
  legalEntityId!: string;

  @ApiProperty({ example: "2026-06-01", description: "Who was on the books that day" })
  @IsDateString()
  on!: string;
}

export class InsuranceRangeDto {
  @ApiProperty({ description: "The entity the filing is for" })
  @IsString()
  @MaxLength(64)
  legalEntityId!: string;

  @ApiProperty({ example: "2026-09-01" })
  @IsDateString()
  from!: string;

  @ApiProperty({ example: "2026-09-30" })
  @IsDateString()
  to!: string;
}
