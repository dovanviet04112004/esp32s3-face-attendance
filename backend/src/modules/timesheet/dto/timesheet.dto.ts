import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { DayCalendar, DayState } from "@prisma/client";
import { Transform, Type } from "class-transformer";
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  Min,
} from "class-validator";

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

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

  @ApiPropertyOptional({ description: "The department and every department under it" })
  @IsOptional()
  @IsUUID()
  departmentId?: string;
}

export class SummaryQueryDto extends ListDaysDto {
  @ApiPropertyOptional({ description: "Employee code or full name, any case" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  search?: string;

  @ApiPropertyOptional({ description: "Only people with an absent, late or corrected day in the range" })
  @IsOptional()
  @Transform(({ value }) => value === true || value === "true")
  @IsBoolean()
  exceptions?: boolean;
}

export class MonthQueryDto {
  @ApiProperty({ example: "2026-09", description: "YYYY-MM" })
  @Matches(MONTH)
  month!: string;
}

export class DaySummaryView {
  @ApiProperty() employeeId!: number;
  @ApiProperty() code!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty() workedDays!: number;
  @ApiProperty() leaveDays!: number;
  @ApiProperty() absentDays!: number;
  @ApiProperty() workedMinutes!: number;
  @ApiProperty() lateMinutes!: number;
  @ApiProperty() overtimeMinutes!: number;
  @ApiProperty({ description: "Days a person corrected by hand" }) adjustedDays!: number;
}

export class DaySummaryPage {
  @ApiProperty({ type: [DaySummaryView] }) rows!: DaySummaryView[];
  @ApiProperty() total!: number;
  @ApiProperty({ description: "False when the count stopped at the ceiling" }) totalIsExact!: boolean;
  @ApiProperty({ type: String, nullable: true }) next!: string | null;
}

export class DayTotalsView {
  @ApiProperty() people!: number;
  @ApiProperty() workedDays!: number;
  @ApiProperty() leaveDays!: number;
  @ApiProperty() absentDays!: number;
  @ApiProperty() workedMinutes!: number;
  @ApiProperty() lateMinutes!: number;
  @ApiProperty() overtimeMinutes!: number;
  @ApiProperty() adjustedDays!: number;
}

export class MonthTallyView {
  @ApiProperty({ example: "2026-09" }) month!: string;
  @ApiProperty() workedDays!: number;
  @ApiProperty({ description: "Days whose first punch came after the grace" }) lateCount!: number;
  @ApiProperty({ description: "Days with a single punch" }) missingPunchDays!: number;
  @ApiProperty() leaveDays!: number;
  @ApiProperty() absentDays!: number;
}

export class DayView {
  @ApiProperty({ type: String, description: "Decimal string" }) id!: string;
  @ApiProperty() employeeId!: number;
  @ApiProperty({ example: "2026-09-14" }) date!: string;
  @ApiProperty({ enum: DayState }) state!: DayState;
  @ApiProperty({ enum: DayCalendar }) calendar!: DayCalendar;
  @ApiProperty({ type: String, nullable: true }) firstIn!: string | null;
  @ApiProperty({ type: String, nullable: true }) lastOut!: string | null;
  @ApiProperty() workedMinutes!: number;
  @ApiProperty() lateMinutes!: number;
  @ApiProperty() earlyLeaveMinutes!: number;
  @ApiProperty() overtimeMinutes!: number;
  @ApiProperty() punchCount!: number;
  @ApiProperty({ type: Number, nullable: true }) measuredMinutes!: number | null;
  @ApiProperty({ type: String, nullable: true }) adjustReason!: string | null;
}

export class BuildQueued {
  @ApiProperty() jobId!: string;
}

export class BuildStateView {
  @ApiProperty({ enum: ["waiting", "active", "completed", "failed", "gone"] }) state!: string;
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
