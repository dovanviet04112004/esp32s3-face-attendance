import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import { IsBoolean, IsDateString, IsInt, IsOptional, IsString, MaxLength, Min } from "class-validator";

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

  // Boolean("false") is true, so a query string has to be compared, not cast.
  @ApiPropertyOptional({ description: "Only punches the kiosk took while it was offline" })
  @IsOptional()
  @Transform(({ value }) => value === true || value === "true")
  @IsBoolean()
  capturedOffline?: boolean;

  @ApiPropertyOptional({ description: "Only punches stamped by a clock that had not synced" })
  @IsOptional()
  @Transform(({ value }) => value === true || value === "true")
  @IsBoolean()
  clockUnsynced?: boolean;
}

export class PunchView {
  @ApiProperty({ type: String, description: "Decimal string" }) id!: string;
  @ApiProperty() localId!: string;
  @ApiProperty() deviceId!: string;
  @ApiProperty() employeeId!: number;
  @ApiProperty() ts!: string;
  @ApiProperty() direction!: string;
  @ApiProperty({ type: Number, nullable: true }) score!: number | null;
  @ApiProperty({ type: Number, nullable: true }) livenessScore!: number | null;
  @ApiProperty() doorOpened!: boolean;
  @ApiProperty() capturedOffline!: boolean;
  @ApiProperty() clockUnsynced!: boolean;
}

export class PunchPageView {
  @ApiProperty({ type: [PunchView] }) rows!: PunchView[];
  @ApiProperty() total!: number;
  @ApiProperty() totalIsExact!: boolean;
  @ApiProperty({ type: String, nullable: true }) next!: string | null;
}

export class PunchCountsView {
  @ApiProperty() all!: number;
  @ApiProperty() capturedOffline!: number;
  @ApiProperty() clockUnsynced!: number;
}
