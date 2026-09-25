import { ApiProperty, ApiPropertyOptional, OmitType, PartialType } from "@nestjs/swagger";
import { ContractKind, ContractState, LaborCategory } from "@prisma/client";
import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from "class-validator";

// One department at a time; a bigger move is several moves.
const kReorgMax = 5_000;
const kMaxGrade = 99;
const FIRST_YEAR = 2000;
const LAST_YEAR = 2100;
const CODE = /^[A-Z0-9][A-Z0-9_.-]*$/;

function asFlag({ value }: { value: unknown }): boolean {
  return value === true || value === "true";
}

/** A catalogue answers pickers with what is in use; its own admin page asks for all. */
export class ListCatalogueDto {
  @ApiPropertyOptional({ default: false, description: "Include retired rows" })
  @IsOptional()
  @Transform(asFlag)
  @IsBoolean()
  all?: boolean;
}

export class ListDepartmentsDto extends ListCatalogueDto {
  @ApiPropertyOptional({ description: "Only this entity's tree" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  legalEntityId?: string;
}

export class HolidayQueryDto {
  @ApiPropertyOptional({ minimum: FIRST_YEAR, maximum: LAST_YEAR, description: "Defaults to this year" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(FIRST_YEAR)
  @Max(LAST_YEAR)
  year?: number;
}

export class ReorgQueryDto {
  @ApiPropertyOptional({ default: false, description: "False previews, true carries the move out" })
  @IsOptional()
  @Transform(asFlag)
  @IsBoolean()
  apply?: boolean;
}

export class CreateJobTitleDto {
  @ApiProperty({ example: "KTV", maxLength: 32, description: "Upper case letters, digits, dot, dash" })
  @IsString()
  @Matches(CODE)
  @MaxLength(32)
  code!: string;

  @ApiProperty({ example: "Kỹ thuật viên", maxLength: 128 })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name!: string;

  @ApiPropertyOptional({ minimum: 0, maximum: kMaxGrade, nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(kMaxGrade)
  grade?: number | null;

  @ApiPropertyOptional({ enum: LaborCategory, nullable: true, description: "D02-LT columns 8 to 11" })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsEnum(LaborCategory)
  laborCategory?: LaborCategory | null;
}

export class UpdateJobTitleDto extends PartialType(CreateJobTitleDto) {
  @ApiPropertyOptional({ description: "False retires it: pickers hide it, holders keep it" })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class CreateLegalEntityDto {
  @ApiProperty({ example: "HN01", maxLength: 32 })
  @IsString()
  @Matches(CODE)
  @MaxLength(32)
  code!: string;

  @ApiProperty({ example: "Công ty TNHH Một thành viên", maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional({ maxLength: 20, nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(20)
  taxCode?: string | null;

  @ApiPropertyOptional({ maxLength: 300, nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(300)
  address?: string | null;
}

export class UpdateLegalEntityDto extends PartialType(CreateLegalEntityDto) {
  @ApiPropertyOptional({ description: "False retires it; refused while it still carries work" })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdateHolidayDto {
  @ApiPropertyOptional({ example: "Mung 1 Tet", maxLength: 120 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ description: "An unpaid day still stops it counting absent" })
  @IsOptional()
  @IsBoolean()
  paid?: boolean;
}

export class CreateDepartmentDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  legalEntityId!: string;

  @ApiProperty({ example: "PB0001", maxLength: 32 })
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  code!: string;

  @ApiProperty({ example: "Kỹ thuật", maxLength: 128 })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name!: string;

  @ApiPropertyOptional({ nullable: true, description: "Null for a top-level department" })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(64)
  parentId?: string | null;

  @ApiPropertyOptional({ maxLength: 32, nullable: true })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(32)
  costCentre?: string | null;

  @ApiPropertyOptional({ nullable: true, description: "Employee id of the person heading it" })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(1)
  headId?: number | null;
}

/** Moving a department to another entity would strand its people's filings, so that is not an edit. */
export class UpdateDepartmentDto extends PartialType(OmitType(CreateDepartmentDto, ["legalEntityId"] as const)) {
  @ApiPropertyOptional({ description: "False retires it; refused while people or sub-departments still use it" })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class CreateContractDto {
  @ApiProperty({ example: 1 })
  @IsInt()
  @Min(1)
  employeeId!: number;

  @ApiProperty({ enum: ContractKind })
  @IsEnum(ContractKind)
  kind!: ContractKind;

  @ApiPropertyOptional({ example: "HD-2026-001" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  number?: string;

  @ApiProperty({ example: "2026-01-01" })
  @IsDateString()
  startDate!: string;

  @ApiPropertyOptional({ example: "2027-01-01", description: "Null for an indefinite term" })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({ example: "2026-03-01" })
  @IsOptional()
  @IsDateString()
  probationEnd?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class DecideContractDto {
  @ApiProperty({ enum: ContractState })
  @IsEnum(ContractState)
  state!: ContractState;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class CreateHolidayDto {
  @ApiPropertyOptional({ description: "Null applies the day to every entity" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  legalEntityId?: string;

  @ApiProperty({ example: "2026-02-17" })
  @IsDateString()
  date!: string;

  @ApiProperty({ example: "Mung 1 Tet" })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ default: true, description: "An unpaid day still stops it counting absent" })
  @IsOptional()
  @IsBoolean()
  paid?: boolean;
}

export class ReorgDto {
  @ApiPropertyOptional({ description: "Move these people; leave out to move a whole department" })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(kReorgMax)
  employeeCodes?: string[];

  @ApiPropertyOptional({ description: "Move everybody currently in this department" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  fromDepartmentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  toDepartmentId?: string;

  @ApiPropertyOptional({ description: "Their new manager, by employee code" })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  toManagerCode?: string;
}

export class PersonRefView {
  @ApiProperty() id!: number;
  @ApiProperty() code!: string;
  @ApiProperty() fullName!: string;
}

export class HolidayView {
  @ApiProperty() id!: string;
  @ApiProperty({ nullable: true, type: String }) legalEntityId!: string | null;
  @ApiProperty({ example: "2026-02-17T00:00:00.000Z" }) date!: string;
  @ApiProperty() name!: string;
  @ApiProperty() paid!: boolean;
  @ApiProperty() createdAt!: string;
}

export class LegalEntityView {
  @ApiProperty() id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true, type: String }) taxCode!: string | null;
  @ApiProperty({ nullable: true, type: String }) address!: string | null;
  @ApiProperty() active!: boolean;
  @ApiPropertyOptional({ description: "Active people filed under it; lists only" }) employees?: number;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class JobTitleView {
  @ApiProperty() id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true, type: Number }) grade!: number | null;
  @ApiProperty({ enum: LaborCategory, nullable: true }) laborCategory!: LaborCategory | null;
  @ApiProperty() active!: boolean;
  @ApiPropertyOptional({ description: "Active people holding it; lists only" }) holders?: number;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class DepartmentView {
  @ApiProperty() id!: string;
  @ApiProperty() legalEntityId!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ nullable: true, type: String }) parentId!: string | null;
  @ApiProperty({ nullable: true, type: String }) costCentre!: string | null;
  @ApiProperty({ nullable: true, type: Number }) headId!: number | null;
  @ApiProperty() active!: boolean;
  @ApiPropertyOptional({ description: "People filed directly under it; lists only" }) headcount?: number;
  @ApiPropertyOptional({ type: PersonRefView, nullable: true, description: "Lists only" })
  head?: PersonRefView | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class ReorgRowView {
  @ApiProperty() employeeId!: number;
  @ApiProperty() code!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty({ nullable: true, type: String }) fromDepartment!: string | null;
  @ApiProperty({ nullable: true, type: String }) toDepartment!: string | null;
  @ApiProperty({ nullable: true, type: String }) fromManager!: string | null;
  @ApiProperty({ nullable: true, type: String }) toManager!: string | null;
  @ApiProperty() pendingRequests!: number;
}

export class SightView {
  @ApiProperty() managerCode!: string;
  @ApiProperty({ type: [String] }) employees!: string[];
}

export class ReorgPlanView {
  @ApiProperty() applied!: boolean;
  @ApiProperty({ type: [ReorgRowView] }) moving!: ReorgRowView[];
  @ApiProperty({ type: [SightView] }) losingSight!: SightView[];
  @ApiProperty({ type: [SightView] }) gainingSight!: SightView[];
  @ApiProperty() requestsReassigned!: number;
}
