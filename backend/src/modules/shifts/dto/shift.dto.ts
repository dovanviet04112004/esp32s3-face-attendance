import { ApiProperty, ApiPropertyOptional, PartialType } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsBoolean,
  IsDateString,
  IsInt,
  IsOptional,
  Max,
  IsString,
  Matches,
  MaxLength,
  Min,
} from "class-validator";

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

export class CreateShiftDto {
  @ApiProperty({ example: "Hành chính", maxLength: 64 })
  @IsString()
  @MaxLength(64)
  name!: string;

  @ApiProperty({ example: "08:00", description: "24-hour clock" })
  @Matches(CLOCK, { message: "startTime must read HH:MM on a 24-hour clock" })
  startTime!: string;

  @ApiProperty({ example: "17:30", description: "24-hour clock" })
  @Matches(CLOCK, { message: "endTime must read HH:MM on a 24-hour clock" })
  endTime!: string;

  @ApiPropertyOptional({ minimum: 0, default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  graceMinutes?: number;
}

export class UpdateShiftDto extends PartialType(CreateShiftDto) {
  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  active?: boolean;
}

export class AssignShiftDto {
  @ApiProperty({ example: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  employeeId!: number;

  @ApiProperty({ example: "2026-01-01T00:00:00.000Z" })
  @IsDateString()
  validFrom!: string;

  @ApiPropertyOptional({ example: "2026-12-31T00:00:00.000Z" })
  @IsOptional()
  @IsDateString()
  validTo?: string;
}

const FIRST_YEAR = 2020;
const LAST_YEAR = 2100;

export class RosterDto {
  @ApiProperty({ minimum: FIRST_YEAR, maximum: LAST_YEAR })
  @Type(() => Number)
  @IsInt()
  @Min(FIRST_YEAR)
  @Max(LAST_YEAR)
  year!: number;

  @ApiProperty({ minimum: 1, maximum: 12 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(12)
  month!: number;

  @ApiPropertyOptional({ description: "Somebody else's, when the caller may see them" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  employeeId?: number;
}
