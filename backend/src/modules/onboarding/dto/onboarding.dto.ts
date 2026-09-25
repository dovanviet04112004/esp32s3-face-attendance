import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { ChecklistKind, TaskOwner } from "@prisma/client";
import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";

import { PaginationDto } from "../../../common/dto/pagination.dto.js";

const kMaxItems = 100;
const kDayWindow = 365;

export class TemplateItemDto {
  @ApiProperty({ example: "Cấp máy tính và tài khoản" })
  @IsString()
  @MaxLength(200)
  title!: string;

  @ApiProperty({ enum: TaskOwner })
  @IsEnum(TaskOwner)
  owner!: TaskOwner;

  @ApiProperty({ description: "Days from the anchor; negative falls before it" })
  @Type(() => Number)
  @IsInt()
  @Min(-kDayWindow)
  dueDays!: number;
}

export class CreateTemplateDto {
  @ApiProperty({ enum: ChecklistKind })
  @IsEnum(ChecklistKind)
  kind!: ChecklistKind;

  @ApiProperty({ example: "Nhận việc — kỹ thuật" })
  @IsString()
  @MaxLength(160)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  jobTitleId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  departmentId?: string;

  @ApiProperty({ type: [TemplateItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(kMaxItems)
  @ValidateNested({ each: true })
  @Type(() => TemplateItemDto)
  items!: TemplateItemDto[];
}

export class StartRunDto {
  @ApiProperty()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  employeeId!: number;

  @ApiProperty({ enum: ChecklistKind })
  @IsEnum(ChecklistKind)
  kind!: ChecklistKind;

  @ApiProperty({ example: "2026-10-01", description: "Their first day, or their last" })
  @IsDateString()
  anchorDate!: string;
}

export class FinishTaskDto {
  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class OpenCountsDto {
  @ApiPropertyOptional({ enum: ChecklistKind })
  @IsOptional()
  @IsEnum(ChecklistKind)
  kind?: ChecklistKind;
}

export class ListOpenTasksDto extends PaginationDto {
  @ApiPropertyOptional({ enum: ChecklistKind })
  @IsOptional()
  @IsEnum(ChecklistKind)
  kind?: ChecklistKind;

  @ApiPropertyOptional({ description: "Matches the task title or the person's name or code" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  search?: string;

  @ApiPropertyOptional({ enum: TaskOwner })
  @IsOptional()
  @IsEnum(TaskOwner)
  owner?: TaskOwner;

  // Boolean("false") is true, so a query string has to be compared, not cast.
  @ApiPropertyOptional({ description: "Only the tasks past their due date" })
  @IsOptional()
  @Transform(({ value }) => value === true || value === "true")
  @IsBoolean()
  overdue?: boolean;
}
