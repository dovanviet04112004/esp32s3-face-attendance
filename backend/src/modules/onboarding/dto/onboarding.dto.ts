import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from "@nestjs/swagger";
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
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
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

  @ApiProperty({ example: "Nhận việc — kỹ thuật", maxLength: 160 })
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name!: string;

  @ApiPropertyOptional({ nullable: true, description: "Null fits every job title" })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(64)
  jobTitleId?: string | null;

  @ApiPropertyOptional({ nullable: true, description: "Null fits every department" })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(64)
  departmentId?: string | null;

  @ApiProperty({ type: [TemplateItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(kMaxItems)
  @ValidateNested({ each: true })
  @Type(() => TemplateItemDto)
  items!: TemplateItemDto[];
}

/** Items, when sent, replace the whole list: runs already started hold their own copy. */
export class UpdateTemplateDto extends PartialType(OmitType(CreateTemplateDto, ["kind"] as const)) {
  @ApiPropertyOptional({ description: "False retires it; nobody new is started on it" })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class ListTemplatesDto {
  @ApiPropertyOptional({ enum: ChecklistKind })
  @IsOptional()
  @IsEnum(ChecklistKind)
  kind?: ChecklistKind;

  @ApiPropertyOptional({ default: false, description: "Include retired templates" })
  @IsOptional()
  @Transform(({ value }) => value === true || value === "true")
  @IsBoolean()
  all?: boolean;
}

export class RunQueryDto {
  @ApiPropertyOptional({ enum: ChecklistKind, default: ChecklistKind.ONBOARDING })
  @IsOptional()
  @IsEnum(ChecklistKind)
  kind?: ChecklistKind;
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

/** The same narrowing as the open list, minus owner and lateness, so each count matches its rows. */
export class OpenCountsDto {
  @ApiPropertyOptional({ enum: ChecklistKind })
  @IsOptional()
  @IsEnum(ChecklistKind)
  kind?: ChecklistKind;

  @ApiPropertyOptional({ description: "Matches the task title or the person's name or code" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  search?: string;

  @ApiPropertyOptional({ description: "The person's department and every department under it" })
  @IsOptional()
  @IsUUID()
  departmentId?: string;
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

  @ApiPropertyOptional({ description: "The person's department and every department under it" })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

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

export class CatalogueRefView {
  @ApiProperty() id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
}

export class TemplateItemView {
  @ApiProperty() id!: string;
  @ApiProperty() templateId!: string;
  @ApiProperty() ordinal!: number;
  @ApiProperty() title!: string;
  @ApiProperty({ enum: TaskOwner }) owner!: TaskOwner;
  @ApiProperty() dueDays!: number;
}

export class TemplateView {
  @ApiProperty() id!: string;
  @ApiProperty({ enum: ChecklistKind }) kind!: ChecklistKind;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true, type: String }) jobTitleId!: string | null;
  @ApiProperty({ nullable: true, type: String }) departmentId!: string | null;
  @ApiProperty({ type: CatalogueRefView, nullable: true }) jobTitle!: CatalogueRefView | null;
  @ApiProperty({ type: CatalogueRefView, nullable: true }) department!: CatalogueRefView | null;
  @ApiProperty() active!: boolean;
  @ApiProperty({ type: [TemplateItemView] }) items!: TemplateItemView[];
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class TaskView {
  @ApiProperty() id!: string;
  @ApiProperty() runId!: string;
  @ApiProperty() ordinal!: number;
  @ApiProperty() title!: string;
  @ApiProperty({ enum: TaskOwner }) ownerRole!: TaskOwner;
  @ApiProperty({ nullable: true, type: Number }) ownerId!: number | null;
  @ApiProperty({ example: "2026-10-01T00:00:00.000Z" }) dueOn!: string;
  @ApiProperty({ nullable: true, type: String }) doneAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) doneById!: string | null;
  @ApiProperty({ nullable: true, type: String }) note!: string | null;
}

export class FinishedTaskView extends TaskView {
  @ApiProperty({ description: "Whose checklist it sits on, so their own screens hear of it" })
  employeeId!: number;
}

export class OwnerCountsView {
  @ApiProperty() HR!: number;
  @ApiProperty() MANAGER!: number;
  @ApiProperty() SELF!: number;
}

export class OpenCountsView {
  @ApiProperty() open!: number;
  @ApiProperty() overdue!: number;
  @ApiProperty({ type: OwnerCountsView }) owners!: OwnerCountsView;
}
