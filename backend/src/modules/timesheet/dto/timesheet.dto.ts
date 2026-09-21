import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { DayState } from "@prisma/client";
import { Type } from "class-transformer";
import {
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
} from "class-validator";

import { PaginationDto } from "../../../common/dto/pagination.dto.js";

export class BuildDaysDto {
  @ApiProperty({ example: "2026-08-01" })
  @IsDateString()
  from!: string;

  @ApiProperty({ example: "2026-08-31" })
  @IsDateString()
  to!: string;
}

export class ListDaysDto extends PaginationDto {
  @ApiProperty({ example: "2026-08-01" })
  @IsDateString()
  from!: string;

  @ApiProperty({ example: "2026-08-31" })
  @IsDateString()
  to!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  employeeId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  departmentId?: string;
}

export class CorrectDayDto {
  @ApiPropertyOptional({ enum: DayState })
  @IsOptional()
  @IsEnum(DayState)
  state?: DayState;

  @ApiPropertyOptional({ example: 480 })
  @IsOptional()
  @IsInt()
  @Min(0)
  workedMinutes?: number;

  @ApiProperty({ example: "Quen quet khi ra ve, co xac nhan cua quan ly" })
  @IsString()
  @MaxLength(500)
  reason!: string;
}
