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
import { PersonRefView } from "../../org/dto/org.dto.js";

const kMaxItems = 100;
const kDayWindow = 365;

export class TemplateItemDto {
  @ApiProperty({ description: "What has to be done", example: "Cấp máy tính và tài khoản", maxLength: 200 })
  @IsString()
  @MaxLength(200)
  title!: string;

  @ApiProperty({
    enum: TaskOwner,
    enumName: "TaskOwner",
    description: "Who does it: HR, the person's manager, or the person themselves",
    example: TaskOwner.HR,
  })
  @IsEnum(TaskOwner)
  owner!: TaskOwner;

  @ApiProperty({ description: "Days from the anchor; negative falls before it", minimum: -kDayWindow, example: 3 })
  @Type(() => Number)
  @IsInt()
  @Min(-kDayWindow)
  dueDays!: number;
}

export class CreateTemplateDto {
  @ApiProperty({ enum: ChecklistKind, enumName: "ChecklistKind", description: "Joining or leaving", example: ChecklistKind.ONBOARDING })
  @IsEnum(ChecklistKind)
  kind!: ChecklistKind;

  @ApiProperty({ description: "Name the desk picks it by", example: "Nhận việc — kỹ thuật", maxLength: 160 })
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: "Null fits every job title",
    example: "2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d",
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(64)
  jobTitleId?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: "Null fits every department",
    example: "6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(64)
  departmentId?: string | null;

  @ApiProperty({
    type: [TemplateItemDto],
    minItems: 1,
    maxItems: kMaxItems,
    description: "The steps, in the order they are numbered",
    example: [
      { title: "Cấp máy tính và tài khoản", owner: "HR", dueDays: 0 },
      { title: "Giới thiệu với nhóm", owner: "MANAGER", dueDays: 1 },
      { title: "Đọc nội quy lao động", owner: "SELF", dueDays: 3 },
    ],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(kMaxItems)
  @ValidateNested({ each: true })
  @Type(() => TemplateItemDto)
  items!: TemplateItemDto[];
}

/** Items, when sent, replace the whole list: runs already started hold their own copy. */
export class UpdateTemplateDto extends PartialType(OmitType(CreateTemplateDto, ["kind"] as const)) {
  @ApiPropertyOptional({ description: "False retires it; nobody new is started on it", example: false })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class ListTemplatesDto {
  @ApiPropertyOptional({ enum: ChecklistKind, enumName: "ChecklistKind", description: "Only templates for joining, or only for leaving" })
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
  @ApiPropertyOptional({
    enum: ChecklistKind,
    default: ChecklistKind.ONBOARDING,
    description: "Which of the person's runs: joining or leaving",
  })
  @IsOptional()
  @IsEnum(ChecklistKind)
  kind?: ChecklistKind;
}

export class StartRunDto {
  @ApiProperty({ description: "Employee the checklist is for", example: 42 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  employeeId!: number;

  @ApiProperty({ enum: ChecklistKind, enumName: "ChecklistKind", description: "Joining or leaving", example: ChecklistKind.ONBOARDING })
  @IsEnum(ChecklistKind)
  kind!: ChecklistKind;

  @ApiProperty({ example: "2026-10-01", description: "Their first day, or their last" })
  @IsDateString()
  anchorDate!: string;
}

export class FinishTaskDto {
  @ApiPropertyOptional({ maxLength: 500, description: "How it was done, kept on the task", example: "Đã bàn giao laptop TS0142" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** The same narrowing as the open list, minus owner and lateness, so each count matches its rows. */
export class OpenCountsDto {
  @ApiPropertyOptional({ enum: ChecklistKind, enumName: "ChecklistKind", description: "Only joining, or only leaving, checklists" })
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
  @ApiPropertyOptional({ enum: ChecklistKind, enumName: "ChecklistKind", description: "Only joining, or only leaving, checklists" })
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

  @ApiPropertyOptional({ enum: TaskOwner, enumName: "TaskOwner", description: "Only the tasks waiting on this kind of owner" })
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
  @ApiProperty({ description: "Id of the department or job title", example: "6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f" }) id!: string;
  @ApiProperty({ description: "Its short code", example: "PB0001" }) code!: string;
  @ApiProperty({ description: "Its display name", example: "Kỹ thuật" }) name!: string;
}

export class TemplateItemView {
  @ApiProperty({ description: "Item id", example: "6a7b8c9d-0e1f-4a2b-9c3d-4e5f6a7b8c9d" }) id!: string;
  @ApiProperty({ description: "Template it belongs to", example: "5f6a7b8c-9d0e-4f1a-8b2c-3d4e5f6a7b8c" }) templateId!: string;
  @ApiProperty({ description: "Position in the list, from 1", example: 1 }) ordinal!: number;
  @ApiProperty({ description: "What has to be done", example: "Cấp máy tính và tài khoản" }) title!: string;
  @ApiProperty({ enum: TaskOwner, enumName: "TaskOwner", description: "Who does it" }) owner!: TaskOwner;
  @ApiProperty({ description: "Days from the anchor date; negative falls before it", example: 3 }) dueDays!: number;
}

export class TemplateView {
  @ApiProperty({ description: "Template id", example: "5f6a7b8c-9d0e-4f1a-8b2c-3d4e5f6a7b8c" }) id!: string;
  @ApiProperty({ enum: ChecklistKind, enumName: "ChecklistKind", description: "Joining or leaving" }) kind!: ChecklistKind;
  @ApiProperty({ description: "Name the desk picks it by", example: "Nhận việc — kỹ thuật" }) name!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description: "Job title it is written for; null fits every title",
    example: "2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d",
  })
  jobTitleId!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: "Department it is written for; null fits every department",
    example: "6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",
  })
  departmentId!: string | null;
  @ApiProperty({ type: CatalogueRefView, nullable: true, description: "The job title jobTitleId names" })
  jobTitle!: CatalogueRefView | null;
  @ApiProperty({ type: CatalogueRefView, nullable: true, description: "The department departmentId names" })
  department!: CatalogueRefView | null;
  @ApiProperty({ description: "False once retired; nobody new is started on it" }) active!: boolean;
  @ApiProperty({ type: [TemplateItemView], description: "Its steps, in order" }) items!: TemplateItemView[];
  @ApiProperty({ type: String, format: "date-time", description: "When it was added", example: "2026-02-10T03:00:00.000Z" })
  createdAt!: string;
  @ApiProperty({ type: String, format: "date-time", description: "Last change to the row", example: "2026-08-19T09:20:00.000Z" })
  updatedAt!: string;
}

export class TaskView {
  @ApiProperty({ description: "Task id", example: "8c9d0e1f-2a3b-4c4d-9e5f-6a7b8c9d0e1f" }) id!: string;
  @ApiProperty({ description: "Checklist run it belongs to", example: "7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e" }) runId!: string;
  @ApiProperty({ description: "Position on the run, from 1", example: 1 }) ordinal!: number;
  @ApiProperty({ description: "What has to be done", example: "Cấp máy tính và tài khoản" }) title!: string;
  @ApiProperty({ enum: TaskOwner, enumName: "TaskOwner", description: "Who does it" }) ownerRole!: TaskOwner;
  @ApiProperty({
    nullable: true,
    type: Number,
    description: "Employee who owns it: the person or their manager; null for an HR task or a person with no manager",
    example: 7,
  })
  ownerId!: number | null;
  @ApiProperty({
    type: String,
    format: "date-time",
    description: "Due day, as midnight UTC of the business date",
    example: "2026-10-01T00:00:00.000Z",
  })
  dueOn!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    format: "date-time",
    description: "When it was ticked; null while open",
    example: "2026-10-02T04:10:00.000Z",
  })
  doneAt!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: "Account that ticked it; null while open or once that account is deleted",
    example: "b5f0c3d2-8a41-4e6b-9c2d-7f1e3a5b9c04",
  })
  doneById!: string | null;
  @ApiProperty({ nullable: true, type: String, description: "Note left when it was ticked" }) note!: string | null;
}

export class FinishedTaskView extends TaskView {
  @ApiProperty({ description: "Whose checklist it sits on, so their own screens hear of it", example: 42 })
  employeeId!: number;
}

export class ChecklistRunTemplateView {
  @ApiProperty({ description: "Name of the template the run was copied from", example: "Nhận việc — kỹ thuật" }) name!: string;
}

export class ChecklistRunView {
  @ApiProperty({ description: "Run id", example: "7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e" }) id!: string;
  @ApiProperty({ description: "Employee going through it", example: 42 }) employeeId!: number;
  @ApiProperty({ description: "Template it was copied from", example: "5f6a7b8c-9d0e-4f1a-8b2c-3d4e5f6a7b8c" }) templateId!: string;
  @ApiProperty({ enum: ChecklistKind, enumName: "ChecklistKind", description: "Joining or leaving" }) kind!: ChecklistKind;
  @ApiProperty({
    type: String,
    format: "date-time",
    description: "First or last day the due dates count from, as midnight UTC",
    example: "2026-10-01T00:00:00.000Z",
  })
  anchorDate!: string;
  @ApiProperty({ type: String, format: "date-time", description: "When the run was started", example: "2026-09-28T02:00:00.000Z" })
  startedAt!: string;
  @ApiProperty({ type: [TaskView], description: "Its tasks, in order" }) tasks!: TaskView[];
  @ApiProperty({ type: ChecklistRunTemplateView, description: "The template it was copied from" })
  template!: ChecklistRunTemplateView;
}

export class OpenTaskRunView {
  @ApiProperty({ enum: ChecklistKind, enumName: "ChecklistKind", description: "Joining or leaving" }) kind!: ChecklistKind;
  @ApiProperty({ type: PersonRefView, description: "Employee the checklist is for" }) employee!: PersonRefView;
}

export class OpenTaskView extends TaskView {
  @ApiProperty({ type: OpenTaskRunView, description: "The run it sits on, and whose it is" }) run!: OpenTaskRunView;
}

export class OpenTaskPageView {
  @ApiProperty({ type: [OpenTaskView], description: "One page of open tasks, soonest due first" }) rows!: OpenTaskView[];
  @ApiProperty({ description: "Open tasks matching the filters, counted up to the ceiling" }) total!: number;
  @ApiProperty({ description: "False when counting stopped at the ceiling" }) totalIsExact!: boolean;
  @ApiProperty({
    nullable: true,
    type: String,
    description: "Pass back as cursor for the next page: the last task's id; null on the last page",
    example: "8c9d0e1f-2a3b-4c4d-9e5f-6a7b8c9d0e1f",
  })
  next!: string | null;
}

export class OwnerCountsView {
  @ApiProperty({ description: "Open tasks waiting on HR" }) HR!: number;
  @ApiProperty({ description: "Open tasks waiting on a manager" }) MANAGER!: number;
  @ApiProperty({ description: "Open tasks waiting on the person themselves" }) SELF!: number;
}

export class OpenCountsView {
  @ApiProperty({ description: "Open tasks under the filters" }) open!: number;
  @ApiProperty({ description: "Of those, the ones past their due day" }) overdue!: number;
  @ApiProperty({ type: OwnerCountsView, description: "Open tasks per kind of owner" }) owners!: OwnerCountsView;
}
