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

import { PaginationDto } from "../../../common/dto/pagination.dto.js";
import { BulkSelectionDto, BulkSkipView } from "../../employees/dto/employee.dto.js";
import { DepartmentRef } from "../../leave/dto/queue.dto.js";

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

export class CreateShiftDto {
  @ApiProperty({ example: "Hành chính", maxLength: 64, description: "Unique name the roster shows" })
  @IsString()
  @MaxLength(64)
  name!: string;

  @ApiProperty({ example: "08:00", description: "24-hour clock" })
  @Matches(CLOCK, { message: "startTime must read HH:MM on a 24-hour clock" })
  startTime!: string;

  @ApiProperty({ example: "17:30", description: "24-hour clock" })
  @Matches(CLOCK, { message: "endTime must read HH:MM on a 24-hour clock" })
  endTime!: string;

  @ApiPropertyOptional({
    minimum: 0,
    default: 0,
    example: 10,
    description: "Minutes after startTime a first punch still counts on time",
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  graceMinutes?: number;
}

export class UpdateShiftDto extends PartialType(CreateShiftDto) {
  @ApiPropertyOptional({ example: true, description: "False retires the shift, as DELETE does; true restores it" })
  @IsOptional()
  @IsBoolean()
  @Type(() => Boolean)
  active?: boolean;
}

export class AssignShiftDto {
  @ApiProperty({ example: 1, description: "Employee put on the shift" })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  employeeId!: number;

  @ApiProperty({
    example: "2026-01-01T00:00:00.000Z",
    description: "First day on the shift, as midnight UTC of that date",
  })
  @IsDateString()
  validFrom!: string;

  @ApiPropertyOptional({
    example: "2026-12-31T00:00:00.000Z",
    description: "Last day on the shift, included, as midnight UTC; left out, open-ended",
  })
  @IsOptional()
  @IsDateString()
  validTo?: string;
}

export class AssignManyDto extends BulkSelectionDto {
  @ApiProperty({
    example: "2026-01-01T00:00:00.000Z",
    description: "First day on the shift, as midnight UTC of that date",
  })
  @IsDateString()
  validFrom!: string;

  @ApiPropertyOptional({
    example: "2026-12-31T00:00:00.000Z",
    description: "Last day on the shift, included, as midnight UTC; left out, open-ended",
  })
  @IsOptional()
  @IsDateString()
  validTo?: string;
}

export class ListAssignmentsDto extends PaginationDto {
  @ApiPropertyOptional({ maxLength: 64, description: "Employee code or full name, any case" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  search?: string;
}

class ShiftBatchRowView {
  @ApiProperty({ example: 42, description: "Employee id" }) employeeId!: number;
  @ApiProperty({ example: "NV0042", description: "Employee code" }) code!: string;
  @ApiProperty({ example: "Nguyễn Văn An", description: "Name as on the employee record" }) fullName!: string;
}

export class AssignedManyView {
  @ApiProperty({ example: false, description: "False for a preview; true once written" }) applied!: boolean;
  @ApiProperty({ example: 12, description: "Rows written, or that the preview would write" }) assigned!: number;
  @ApiProperty({ type: [ShiftBatchRowView], description: "People put on the shift, or who would be, by code" })
  rows!: ShiftBatchRowView[];
  @ApiProperty({ type: [BulkSkipView], description: "People who left, or already on the shift from that date" })
  skipped!: BulkSkipView[];
}

export class RosteredPersonView {
  @ApiProperty({ example: 42, description: "Employee id" }) id!: number;
  @ApiProperty({ example: "NV0042", description: "Employee code" }) code!: string;
  @ApiProperty({ example: "Nguyễn Văn An", description: "Name as on the employee record" }) fullName!: string;
  @ApiProperty({ type: DepartmentRef, nullable: true, description: "Where the person sits; null when unplaced" })
  department!: DepartmentRef | null;
}

export class AssignmentView {
  @ApiProperty({ example: "cff6a5b9-52f0-4050-92ef-b929a9911dac", description: "Assignment id (UUID)" }) id!: string;
  @ApiProperty({ example: "2dbf73fd-d71d-4d2a-bacd-0362ce6b4cff", description: "Shift worked" }) shiftId!: string;
  @ApiProperty({ example: 42, description: "Employee on the shift" }) employeeId!: number;
  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-01-01T00:00:00.000Z",
    description: "First day on the shift, as midnight UTC",
  })
  validFrom!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    format: "date-time",
    example: "2026-12-31T00:00:00.000Z",
    description: "Last day on it, included; null when open-ended",
  })
  validTo!: string | null;
}

export class RosteredView extends AssignmentView {
  @ApiProperty({ type: RosteredPersonView, description: "The person on the shift" }) employee!: RosteredPersonView;
}

export class RosterPageView {
  @ApiProperty({ type: [RosteredView], description: "Latest start first" }) rows!: RosteredView[];
  @ApiProperty({ example: 37, description: "Assignments the search reaches, counted no further than the ceiling" })
  total!: number;
  @ApiProperty({ example: true, description: "False when counting stopped at the ceiling, so total is a floor" })
  totalIsExact!: boolean;
  @ApiProperty({
    nullable: true,
    type: String,
    example: "eyJzb3J0VmFsdWUiOiIyMDI2LTAxLTAxVDAwOjAwOjAwLjAwMFoiLCJpZCI6ImNmZjZhNWI5LTUyZjAtNDA1MC05MmVmLWI5MjlhOTkxMWRhYyJ9",
    description: "Cursor for the next page, sent back as cursor; null once a page comes back short",
  })
  next!: string | null;
}

export class ShiftView {
  @ApiProperty({ example: "2dbf73fd-d71d-4d2a-bacd-0362ce6b4cff", description: "Shift id (UUID)" }) id!: string;
  @ApiProperty({ example: "Hành chính", description: "Unique name the roster shows" }) name!: string;
  @ApiProperty({ example: "08:00", description: "Start, HH:MM on a 24-hour clock in APP_TIMEZONE" }) startTime!: string;
  @ApiProperty({ example: "17:30", description: "End, HH:MM on a 24-hour clock in APP_TIMEZONE" }) endTime!: string;
  @ApiProperty({ example: 10, description: "Minutes after startTime a first punch still counts on time" })
  graceMinutes!: number;
  @ApiProperty({ example: true, description: "False once retired" }) active!: boolean;
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
    example: "2026-03-10T04:20:00.000Z",
    description: "When it last changed",
  })
  updatedAt!: string;
}

export class HeldShiftView extends AssignmentView {
  @ApiProperty({ type: ShiftView, description: "The shift and the hours it keeps" }) shift!: ShiftView;
}

class PlannedShiftView {
  @ApiProperty({ example: "2dbf73fd-d71d-4d2a-bacd-0362ce6b4cff", description: "Shift id (UUID)" }) id!: string;
  @ApiProperty({ example: "Hành chính", description: "Shift name" }) name!: string;
  @ApiProperty({ example: "08:00", description: "Start, HH:MM on a 24-hour clock" }) startTime!: string;
  @ApiProperty({ example: "17:30", description: "End, HH:MM on a 24-hour clock" }) endTime!: string;
  @ApiProperty({ example: 10, description: "Minutes after startTime a first punch still counts on time" })
  graceMinutes!: number;
}

export class PlannedDayView {
  @ApiProperty({ type: String, format: "date", example: "2026-10-05", description: "The calendar day, YYYY-MM-DD" })
  date!: string;
  @ApiProperty({
    type: PlannedShiftView,
    nullable: true,
    description: "Shift the person is on that day, the latest assignment winning; null without one",
  })
  shift!: PlannedShiftView | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "Quốc khánh",
    description: "Name of a holiday declared on that date; null on an ordinary day",
  })
  holiday!: string | null;
  @ApiProperty({ example: false, description: "Saturday or Sunday" }) weekend!: boolean;
  @ApiProperty({
    enum: ["LEAVE", "BUSINESS_TRIP", "REMOTE_WORK"],
    enumName: "AwayKind",
    nullable: true,
    example: "LEAVE",
    description: "An approved whole-day request that keeps the person away; null when none",
  })
  away!: string | null;
}

const FIRST_YEAR = 2020;
const LAST_YEAR = 2100;

export class RosterDto {
  @ApiProperty({ minimum: FIRST_YEAR, maximum: LAST_YEAR, example: 2026, description: "Calendar year of the month" })
  @Type(() => Number)
  @IsInt()
  @Min(FIRST_YEAR)
  @Max(LAST_YEAR)
  year!: number;

  @ApiProperty({ minimum: 1, maximum: 12, example: 10, description: "Month to plan, 1 for January" })
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
