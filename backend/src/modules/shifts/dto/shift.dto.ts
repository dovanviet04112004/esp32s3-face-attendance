import { ApiProperty, ApiPropertyOptional, PartialType } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
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
import { DepartmentRef } from "../../leave/dto/queue.dto.js";

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

const kMaxBulkAssign = 500;

export class AssignManyDto {
  @ApiProperty({ type: [Number], maxItems: kMaxBulkAssign, example: [1, 2, 3] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(kMaxBulkAssign)
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  employeeIds!: number[];

  @ApiProperty({ example: "2026-01-01T00:00:00.000Z" })
  @IsDateString()
  validFrom!: string;

  @ApiPropertyOptional({ example: "2026-12-31T00:00:00.000Z" })
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

export class AssignedManyView {
  @ApiProperty({ description: "Rows written" }) assigned!: number;
  @ApiProperty({ description: "People already on the shift from that date" }) skipped!: number;
}

export class RosteredPersonView {
  @ApiProperty() id!: number;
  @ApiProperty() code!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty({ type: DepartmentRef, nullable: true }) department!: DepartmentRef | null;
}

export class AssignmentView {
  @ApiProperty() id!: string;
  @ApiProperty() shiftId!: string;
  @ApiProperty() employeeId!: number;
  @ApiProperty() validFrom!: string;
  @ApiProperty({ nullable: true, type: String }) validTo!: string | null;
}

export class RosteredView extends AssignmentView {
  @ApiProperty({ type: RosteredPersonView }) employee!: RosteredPersonView;
}

export class RosterPageView {
  @ApiProperty({ type: [RosteredView] }) rows!: RosteredView[];
  @ApiProperty() total!: number;
  @ApiProperty() totalIsExact!: boolean;
  @ApiProperty({ nullable: true, type: String }) next!: string | null;
}

export class ShiftView {
  @ApiProperty() id!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ example: "08:00" }) startTime!: string;
  @ApiProperty({ example: "17:30" }) endTime!: string;
  @ApiProperty() graceMinutes!: number;
  @ApiProperty() active!: boolean;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class HeldShiftView extends AssignmentView {
  @ApiProperty({ type: ShiftView }) shift!: ShiftView;
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
