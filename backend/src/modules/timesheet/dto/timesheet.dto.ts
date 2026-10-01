import { ApiProperty, ApiPropertyOptional, IntersectionType } from "@nestjs/swagger";
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

/** The most day rows GET /timesheet answers with; a range holding more is refused (KEHOACH 9.12). */
export const MAX_DAY_ROWS = 5_000;

export class BuildDaysDto {
  @ApiProperty({ example: "2026-08-01", description: "First business day to build, YYYY-MM-DD in APP_TIMEZONE" })
  @IsDateString()
  from!: string;

  @ApiProperty({
    example: "2026-08-31",
    description: "Last business day to build, included; a day that has not ended yet is skipped",
  })
  @IsDateString()
  to!: string;
}

export class ListDaysDto {
  @ApiProperty({ example: "2026-08-01", description: "First business day, YYYY-MM-DD in APP_TIMEZONE, included" })
  @IsDateString()
  from!: string;

  @ApiProperty({ example: "2026-08-31", description: "Last business day, YYYY-MM-DD in APP_TIMEZONE, included" })
  @IsDateString()
  to!: string;

  @ApiPropertyOptional({
    example: 42,
    description: "Only this employee; someone outside the viewer's reach yields no rows",
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  employeeId?: number;

  @ApiPropertyOptional({
    example: "6aef5afe-433e-4daa-9ece-c33b41d3a660",
    description: "The department and every department under it",
  })
  @IsOptional()
  @IsUUID()
  departmentId?: string;
}

export class SummaryQueryDto extends IntersectionType(ListDaysDto, PaginationDto) {
  @ApiPropertyOptional({ example: "NV0042", description: "Employee code or full name, any case" })
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
  @ApiProperty({ example: 42, description: "Employee id" }) employeeId!: number;
  @ApiProperty({ example: "NV0042", description: "Employee code" }) code!: string;
  @ApiProperty({ example: "Nguyễn Văn An", description: "Name as on the employee record" }) fullName!: string;
  @ApiProperty({ example: 20, description: "Days in the range counted WORKED" }) workedDays!: number;
  @ApiProperty({ example: 1, description: "Days in the range on approved leave" }) leaveDays!: number;
  @ApiProperty({ example: 1, description: "Working days with no punch and nothing approved" }) absentDays!: number;
  @ApiProperty({ example: 9600, description: "Minutes from first to last punch, summed over the range" })
  workedMinutes!: number;
  @ApiProperty({ example: 35, description: "Minutes past shift start plus grace, summed over the range" })
  lateMinutes!: number;
  @ApiProperty({ example: 120, description: "Measured overtime minutes, summed; only approved ones are paid" })
  overtimeMinutes!: number;
  @ApiProperty({ example: 0, description: "Days a person corrected by hand" }) adjustedDays!: number;
}

export class DaySummaryPage {
  @ApiProperty({ type: [DaySummaryView], description: "One row per person, by employee code" }) rows!: DaySummaryView[];
  @ApiProperty({ example: 120, description: "People the filter reaches, counted no further than the ceiling" })
  total!: number;
  @ApiProperty({ example: true, description: "False when the count stopped at the ceiling" }) totalIsExact!: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "eyJzb3J0VmFsdWUiOiJOVjAwNDIiLCJpZCI6IjQyIn0",
    description: "Cursor for the next page, sent back as cursor; null once a page comes back short",
  })
  next!: string | null;
}

export class DayTotalsView {
  @ApiProperty({ example: 120, description: "People the filter reaches" }) people!: number;
  @ApiProperty({ example: 2380, description: "Days counted WORKED, over everybody" }) workedDays!: number;
  @ApiProperty({ example: 64, description: "Days on approved leave, over everybody" }) leaveDays!: number;
  @ApiProperty({ example: 31, description: "Working days with no punch and nothing approved, over everybody" })
  absentDays!: number;
  @ApiProperty({ example: 1142400, description: "Minutes from first to last punch, over everybody" })
  workedMinutes!: number;
  @ApiProperty({ example: 4210, description: "Minutes past shift start plus grace, over everybody" })
  lateMinutes!: number;
  @ApiProperty({ example: 15300, description: "Measured overtime minutes, over everybody" }) overtimeMinutes!: number;
  @ApiProperty({ example: 12, description: "Days corrected by hand, over everybody" }) adjustedDays!: number;
}

export class MonthTallyView {
  @ApiProperty({ example: "2026-09", description: "The month counted, YYYY-MM" }) month!: string;
  @ApiProperty({ example: 15, description: "Days counted WORKED so far; today is not built yet" })
  workedDays!: number;
  @ApiProperty({ example: 2, description: "Days whose first punch came after the grace" }) lateCount!: number;
  @ApiProperty({ example: 1, description: "Days with a single punch" }) missingPunchDays!: number;
  @ApiProperty({ example: 1, description: "Days on approved leave" }) leaveDays!: number;
  @ApiProperty({ example: 0, description: "Working days with no punch and nothing approved" }) absentDays!: number;
}

export class DayView {
  @ApiProperty({ type: String, example: "18342", description: "Row id, a 64-bit integer sent as a decimal string" })
  id!: string;
  @ApiProperty({ example: 42, description: "Employee the day belongs to" }) employeeId!: number;
  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-09-14T00:00:00.000Z",
    description: "Business date in APP_TIMEZONE, sent as midnight UTC",
  })
  date!: string;
  @ApiProperty({
    enum: DayState,
    enumName: "DayState",
    example: DayState.WORKED,
    description: "What the person did that day",
  })
  state!: DayState;
  @ApiProperty({
    enum: DayCalendar,
    enumName: "DayCalendar",
    example: DayCalendar.WORKDAY,
    description: "What the calendar made the day, whatever the person did; overtime is priced by it",
  })
  calendar!: DayCalendar;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "2dbf73fd-d71d-4d2a-bacd-0362ce6b4cff",
    description: "Shift in force that day; null without one",
  })
  shiftId!: string | null;
  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    example: "2026-09-14T01:02:11.000Z",
    description: "First punch of the day; null without punches",
  })
  firstIn!: string | null;
  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    example: "2026-09-14T10:35:40.000Z",
    description: "Last punch of the day; null without punches",
  })
  lastOut!: string | null;
  @ApiProperty({ example: 513, description: "Minutes from first to last punch, or the figure a correction set" })
  workedMinutes!: number;
  @ApiProperty({ example: 0, description: "Minutes past shift start plus grace; 0 without a shift or off a workday" })
  lateMinutes!: number;
  @ApiProperty({ example: 0, description: "Minutes the last punch fell short of shift end; 0 without a shift" })
  earlyLeaveMinutes!: number;
  @ApiProperty({
    example: 35,
    description: "Minutes past shift end, or every minute worked on a day off; counted, not yet paid",
  })
  overtimeMinutes!: number;
  @ApiProperty({ example: 2, description: "Punches folded into the day" }) punchCount!: number;
  @ApiProperty({ example: false, description: "A punch came from a kiosk clock that had not synced" })
  clockUnsynced!: boolean;
  @ApiProperty({
    type: Number,
    nullable: true,
    example: 513,
    description: "Minutes the device measured, kept under a hand correction; null on a day without punches",
  })
  measuredMinutes!: number | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "ab35f74f-dd47-4ad6-8e4c-fb243e7ac176",
    description: "Account that corrected the day by hand; null if nobody did",
  })
  adjustedById!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "Trần Thị B",
    description: "Who corrected the day: their name, or their email when the account has no record",
  })
  adjustedByName!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "Quên quét khi ra về, có xác nhận của quản lý",
    description: "Why the day was corrected by hand; null if it never was",
  })
  adjustReason!: string | null;
  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    example: "2026-09-15T02:10:00.000Z",
    description: "When the hand correction was made; null if none",
  })
  adjustedAt!: string | null;
  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-09-14T17:30:04.000Z",
    description: "When the row was first written",
  })
  builtAt!: string;
  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-09-15T02:10:00.000Z",
    description: "When the row last changed",
  })
  updatedAt!: string;
}

export class BuildQueued {
  @ApiProperty({ example: "1842", description: "Queue job id; GET /timesheet/build/{jobId} reports on it" })
  jobId!: string;
}

export class BuildStateView {
  @ApiProperty({
    enum: ["waiting", "active", "completed", "failed", "gone"],
    enumName: "BuildState",
    example: "active",
    description: "Where the job stands; gone means the queue no longer holds it",
  })
  state!: string;
}

export class CorrectDayDto {
  @ApiPropertyOptional({
    enum: DayState,
    enumName: "DayState",
    example: DayState.WORKED,
    description: "The state to record; at least one of state and workedMinutes is required",
  })
  @IsOptional()
  @IsEnum(DayState)
  state?: DayState;

  @ApiPropertyOptional({
    example: 480,
    description: "Minutes worked to record; the measured figure stays in measuredMinutes",
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  workedMinutes?: number;

  @ApiProperty({
    example: "Quen quet khi ra ve, co xac nhan cua quan ly",
    description: "Why the day is corrected; kept on the row and in the audit trail",
  })
  @IsString()
  @MaxLength(500)
  reason!: string;
}
