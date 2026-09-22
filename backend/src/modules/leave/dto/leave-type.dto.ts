import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsBoolean, IsNumber, IsOptional, IsString, Matches, Max, Min } from "class-validator";

const CODE_SHAPE = /^[A-Z][A-Z0-9_]{1,31}$/;
const DAYS_MAX = 365;

export class CreateLeaveTypeDto {
  @ApiProperty({ example: "ANNUAL", description: "Capitals and underscores; the row is keyed on it" })
  @IsString()
  @Matches(CODE_SHAPE)
  code!: string;

  @ApiProperty({ example: "Nghỉ phép năm" })
  @IsString()
  name!: string;

  @ApiPropertyOptional({ default: true, description: "An unpaid kind still books the day off" })
  @IsOptional()
  @IsBoolean()
  paid?: boolean;

  @ApiProperty({ example: 12, description: "Whole or half days a full year of service earns" })
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0)
  @Max(DAYS_MAX)
  daysPerYear!: number;

  @ApiPropertyOptional({ example: 5, description: "How much of it may cross into the next year" })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0)
  @Max(DAYS_MAX)
  carryOverMax?: number;
}

export class UpdateLeaveTypeDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  paid?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0)
  @Max(DAYS_MAX)
  daysPerYear?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0)
  @Max(DAYS_MAX)
  carryOverMax?: number;

  @ApiPropertyOptional({ description: "Retiring one leaves every balance already granted alone" })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
