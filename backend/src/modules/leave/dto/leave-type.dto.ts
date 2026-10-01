import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsBoolean, IsNumber, IsOptional, IsString, Matches, Max, Min } from "class-validator";

const CODE_SHAPE = /^[A-Z][A-Z0-9_]{1,31}$/;
const DAYS_MAX = 365;

export class CreateLeaveTypeDto {
  @ApiProperty({ example: "ANNUAL", description: "Capitals and underscores; the row is keyed on it" })
  @IsString()
  @Matches(CODE_SHAPE)
  code!: string;

  @ApiProperty({ example: "Nghỉ phép năm", description: "Name the filing form and the balances show" })
  @IsString()
  name!: string;

  @ApiPropertyOptional({ default: true, example: true, description: "An unpaid kind still books the day off" })
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

  @ApiPropertyOptional({
    default: false,
    example: false,
    description: "Count every calendar day, as maternity leave does",
  })
  @IsOptional()
  @IsBoolean()
  calendarDays?: boolean;
}

export class UpdateLeaveTypeDto {
  @ApiPropertyOptional({ example: "Nghỉ phép năm", description: "Name the filing form and the balances show" })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ example: true, description: "False makes it unpaid: no balance limits it" })
  @IsOptional()
  @IsBoolean()
  paid?: boolean;

  @ApiPropertyOptional({
    example: 14,
    description: "Days a full year earns from the next grant on; balances already granted keep theirs",
  })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0)
  @Max(DAYS_MAX)
  daysPerYear?: number;

  @ApiPropertyOptional({ example: 5, description: "Days that may cross into the next year, whole or half" })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0)
  @Max(DAYS_MAX)
  carryOverMax?: number;

  @ApiPropertyOptional({ example: false, description: "Count every calendar day, as maternity leave does" })
  @IsOptional()
  @IsBoolean()
  calendarDays?: boolean;

  @ApiPropertyOptional({ example: true, description: "Retiring one leaves every balance already granted alone" })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class LeaveTypeView {
  @ApiProperty({ example: "99f79587-ad8b-41a8-8b53-f502c36fe29b", description: "Leave type id (UUID)" })
  id!: string;

  @ApiProperty({ example: "ANNUAL", description: "Capitals and underscores; unique" })
  code!: string;

  @ApiProperty({ example: "Nghỉ phép năm", description: "Name the filing form and the balances show" })
  name!: string;

  @ApiProperty({ example: true, description: "False: unpaid, and no balance limits it" })
  paid!: boolean;

  @ApiProperty({ example: "12", description: "Days a full year of service earns, a decimal string with one place" })
  daysPerYear!: string;

  @ApiProperty({ example: "5", description: "Days that may cross into the next year, a decimal string" })
  carryOverMax!: string;

  @ApiProperty({ example: false, description: "Counts every calendar day, as maternity leave does" })
  calendarDays!: boolean;

  @ApiProperty({ example: true, description: "False once retired: kept on old requests, offered to no new one" })
  active!: boolean;

  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-01-05T02:00:00.000Z",
    description: "When it was added",
  })
  createdAt!: string;

  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-06-01T03:15:00.000Z",
    description: "When it last changed",
  })
  updatedAt!: string;
}
