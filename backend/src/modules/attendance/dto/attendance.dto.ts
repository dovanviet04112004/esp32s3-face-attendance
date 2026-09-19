import { ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsDateString, IsInt, IsOptional, IsString, MaxLength, Min } from "class-validator";

import { PaginationDto } from "../../../common/dto/pagination.dto.js";

export class ListAttendanceDto extends PaginationDto {
  @ApiPropertyOptional({ description: "Only this employee's punches" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  employeeId?: number;

  @ApiPropertyOptional({ description: "Only punches taken on this kiosk" })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  deviceId?: string;

  @ApiPropertyOptional({ example: "2026-09-01T00:00:00.000Z" })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ example: "2026-09-30T23:59:59.000Z" })
  @IsOptional()
  @IsDateString()
  to?: string;
}
