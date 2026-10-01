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
  @ApiProperty({ example: "KTV", maxLength: 32, description: "Short code, unique; upper case letters, digits, dot, dash" })
  @IsString()
  @Matches(CODE)
  @MaxLength(32)
  code!: string;

  @ApiProperty({ description: "Name pickers show", example: "Kỹ thuật viên", maxLength: 128 })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name!: string;

  @ApiPropertyOptional({
    type: Number,
    minimum: 0,
    maximum: kMaxGrade,
    nullable: true,
    description: "Rung on the grade ladder; null for none",
    example: 3,
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(kMaxGrade)
  grade?: number | null;

  @ApiPropertyOptional({
    enum: LaborCategory,
    enumName: "LaborCategory",
    nullable: true,
    description: "D02-LT columns 8 to 11",
    example: LaborCategory.MID_SKILLED,
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsEnum(LaborCategory)
  laborCategory?: LaborCategory | null;
}

export class UpdateJobTitleDto extends PartialType(CreateJobTitleDto) {
  @ApiPropertyOptional({ description: "False retires it: pickers hide it, holders keep it", example: false })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class CreateLegalEntityDto {
  @ApiProperty({ description: "Short code, unique; upper case letters, digits, dot, dash", example: "HN01", maxLength: 32 })
  @IsString()
  @Matches(CODE)
  @MaxLength(32)
  code!: string;

  @ApiProperty({ description: "Registered company name, as filings print it", example: "Công ty TNHH Một thành viên", maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @ApiPropertyOptional({
    type: String,
    maxLength: 20,
    nullable: true,
    description: "Enterprise tax code the filings carry",
    example: "0101234567",
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(20)
  taxCode?: string | null;

  @ApiPropertyOptional({
    type: String,
    maxLength: 300,
    nullable: true,
    description: "Registered address",
    example: "Số 1 Đại Cồ Việt, Hai Bà Trưng, Hà Nội",
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(300)
  address?: string | null;
}

export class UpdateLegalEntityDto extends PartialType(CreateLegalEntityDto) {
  @ApiPropertyOptional({ description: "False retires it; refused while it still carries work", example: false })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class UpdateHolidayDto {
  @ApiPropertyOptional({ description: "Name the calendar shows", example: "Mung 1 Tet", maxLength: 120 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ description: "An unpaid day still stops it counting absent", example: true })
  @IsOptional()
  @IsBoolean()
  paid?: boolean;
}

export class CreateDepartmentDto {
  @ApiProperty({
    description: "Entity whose payroll and filings it belongs to",
    example: "0e9a7b6c-5d4e-4f3a-8b2c-1d0e9f8a7b6c",
    maxLength: 64,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  legalEntityId!: string;

  @ApiProperty({ description: "Short code, unique within its entity", example: "PB0001", maxLength: 32 })
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  code!: string;

  @ApiProperty({ description: "Name the tree shows", example: "Kỹ thuật", maxLength: 128 })
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  name!: string;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: "Null for a top-level department",
    example: "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d",
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(64)
  parentId?: string | null;

  @ApiPropertyOptional({ type: String, maxLength: 32, nullable: true, description: "Accounting cost centre code", example: "CC-KT01" })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(32)
  costCentre?: string | null;

  @ApiPropertyOptional({ type: Number, nullable: true, description: "Employee id of the person heading it", example: 7 })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(1)
  headId?: number | null;
}

/** Moving a department to another entity would strand its people's filings, so that is not an edit. */
export class UpdateDepartmentDto extends PartialType(OmitType(CreateDepartmentDto, ["legalEntityId"] as const)) {
  @ApiPropertyOptional({
    description: "False retires it; refused while people or sub-departments still use it",
    example: false,
  })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class CreateContractDto {
  @ApiProperty({ description: "Employee who signs it", example: 1 })
  @IsInt()
  @Min(1)
  employeeId!: number;

  @ApiProperty({ enum: ContractKind, enumName: "ContractKind", description: "Term of the contract", example: ContractKind.FIXED_TERM })
  @IsEnum(ContractKind)
  kind!: ContractKind;

  @ApiPropertyOptional({ description: "Number printed on the paper contract", example: "HD-2026-001", maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  number?: string;

  @ApiProperty({ description: "First day it covers", example: "2026-01-01" })
  @IsDateString()
  startDate!: string;

  @ApiPropertyOptional({ example: "2027-01-01", description: "Null for an indefinite term" })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({ description: "Last day of probation, when there is one", example: "2026-03-01" })
  @IsOptional()
  @IsDateString()
  probationEnd?: string;

  @ApiPropertyOptional({ description: "Free note kept with the contract", example: "Ký lại sau thử việc", maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class DecideContractDto {
  @ApiProperty({
    enum: ContractState,
    enumName: "ContractState",
    description: "Where to move it; ACTIVE ends the person's other active contract",
    example: ContractState.ACTIVE,
  })
  @IsEnum(ContractState)
  state!: ContractState;

  @ApiPropertyOptional({
    description: "Note kept with the contract; left out keeps the one it has",
    example: "Đã ký bản giấy",
    maxLength: 500,
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class CreateHolidayDto {
  @ApiPropertyOptional({ description: "Null applies the day to every entity", example: "0e9a7b6c-5d4e-4f3a-8b2c-1d0e9f8a7b6c" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  legalEntityId?: string;

  @ApiProperty({ description: "The day off", example: "2026-02-17" })
  @IsDateString()
  date!: string;

  @ApiProperty({ description: "Name the calendar shows", example: "Mung 1 Tet", maxLength: 120 })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ default: true, description: "An unpaid day still stops it counting absent", example: true })
  @IsOptional()
  @IsBoolean()
  paid?: boolean;
}

export class ReorgDto {
  @ApiPropertyOptional({
    type: [String],
    maxItems: kReorgMax,
    description: "Move these people, by employee code; leave out to move a whole department",
    example: ["NV0002", "NV0003"],
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(kReorgMax)
  employeeCodes?: string[];

  @ApiPropertyOptional({ description: "Move everybody currently in this department", example: "6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  fromDepartmentId?: string;

  @ApiPropertyOptional({
    description: "Department they move into; left out, each keeps their own",
    example: "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d",
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  toDepartmentId?: string;

  @ApiPropertyOptional({ description: "Their new manager, by employee code", example: "NV0001" })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  toManagerCode?: string;
}

export class PersonRefView {
  @ApiProperty({ example: 42, description: "Employee id" }) id!: number;
  @ApiProperty({ example: "NV0042", description: "Employee code" }) code!: string;
  @ApiProperty({ example: "Nguyễn Văn An", description: "Name as on the employee record" }) fullName!: string;
}

export class HolidayView {
  @ApiProperty({ description: "Holiday id", example: "2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e" }) id!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description: "Entity the day applies to; null for every entity",
    example: "0e9a7b6c-5d4e-4f3a-8b2c-1d0e9f8a7b6c",
  })
  legalEntityId!: string | null;
  @ApiProperty({
    type: String,
    format: "date-time",
    description: "The day off, as midnight UTC of that date",
    example: "2026-02-17T00:00:00.000Z",
  })
  date!: string;
  @ApiProperty({ description: "Name the calendar shows", example: "Mung 1 Tet" }) name!: string;
  @ApiProperty({ description: "Whether the day is paid; either way nobody counts absent on it" }) paid!: boolean;
  @ApiProperty({ type: String, format: "date-time", description: "When it was added", example: "2025-12-15T02:00:00.000Z" })
  createdAt!: string;
}

export class ContractView {
  @ApiProperty({ description: "Contract id", example: "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f" }) id!: string;
  @ApiProperty({ description: "Employee who signed it", example: 42 }) employeeId!: number;
  @ApiProperty({ enum: ContractKind, enumName: "ContractKind", description: "Term of the contract" }) kind!: ContractKind;
  @ApiProperty({
    enum: ContractState,
    enumName: "ContractState",
    description: "Where it stands; a person has at most one ACTIVE at a time",
  })
  state!: ContractState;
  @ApiProperty({ nullable: true, type: String, description: "Number printed on the paper contract", example: "HD-2026-001" })
  number!: string | null;
  @ApiProperty({
    type: String,
    format: "date-time",
    description: "First day it covers, as midnight UTC",
    example: "2026-01-01T00:00:00.000Z",
  })
  startDate!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    format: "date-time",
    description: "Last day it covers, as midnight UTC; null for an indefinite term",
    example: "2027-01-01T00:00:00.000Z",
  })
  endDate!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    format: "date-time",
    description: "Last day of probation, as midnight UTC; null without one",
    example: "2026-03-01T00:00:00.000Z",
  })
  probationEnd!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    format: "date-time",
    description: "Stamped the first time it is made ACTIVE; null before that",
    example: "2026-01-02T03:00:00.000Z",
  })
  signedAt!: string | null;
  @ApiProperty({ nullable: true, type: String, description: "Free note kept with the contract" }) note!: string | null;
  @ApiProperty({ type: String, format: "date-time", description: "When it was entered", example: "2025-12-28T08:00:00.000Z" })
  createdAt!: string;
  @ApiProperty({ type: String, format: "date-time", description: "Last change to the row", example: "2026-01-02T03:00:00.000Z" })
  updatedAt!: string;
}

export class LegalEntityView {
  @ApiProperty({ description: "Legal entity id", example: "0e9a7b6c-5d4e-4f3a-8b2c-1d0e9f8a7b6c" }) id!: string;
  @ApiProperty({ description: "Short code, unique", example: "HN01" }) code!: string;
  @ApiProperty({ description: "Registered company name", example: "Công ty TNHH Một thành viên" }) name!: string;
  @ApiProperty({ nullable: true, type: String, description: "Enterprise tax code the filings carry", example: "0101234567" })
  taxCode!: string | null;
  @ApiProperty({ nullable: true, type: String, description: "Registered address" }) address!: string | null;
  @ApiProperty({ description: "False once retired" }) active!: boolean;
  @ApiPropertyOptional({ description: "Active people filed under it; lists only" }) employees?: number;
  @ApiProperty({ type: String, format: "date-time", description: "When it was added", example: "2025-11-03T02:00:00.000Z" })
  createdAt!: string;
  @ApiProperty({ type: String, format: "date-time", description: "Last change to the row", example: "2026-05-20T04:30:00.000Z" })
  updatedAt!: string;
}

export class JobTitleView {
  @ApiProperty({ description: "Job title id", example: "2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d" }) id!: string;
  @ApiProperty({ description: "Short code, unique", example: "KTV" }) code!: string;
  @ApiProperty({ description: "Name pickers show", example: "Kỹ thuật viên" }) name!: string;
  @ApiProperty({ nullable: true, type: Number, description: "Rung on the grade ladder, 0 to 99", example: 3 }) grade!: number | null;
  @ApiProperty({
    enum: LaborCategory,
    enumName: "LaborCategory",
    nullable: true,
    description: "Position group of the D02-LT filing, columns 8 to 11",
  })
  laborCategory!: LaborCategory | null;
  @ApiProperty({ description: "False once retired: pickers hide it, holders keep it" }) active!: boolean;
  @ApiPropertyOptional({ description: "Active people holding it; lists only" }) holders?: number;
  @ApiProperty({ type: String, format: "date-time", description: "When it was added", example: "2025-11-03T02:00:00.000Z" })
  createdAt!: string;
  @ApiProperty({ type: String, format: "date-time", description: "Last change to the row", example: "2026-05-20T04:30:00.000Z" })
  updatedAt!: string;
}

export class DepartmentView {
  @ApiProperty({ description: "Department id", example: "6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f" }) id!: string;
  @ApiProperty({ description: "Entity it belongs to", example: "0e9a7b6c-5d4e-4f3a-8b2c-1d0e9f8a7b6c" }) legalEntityId!: string;
  @ApiProperty({ description: "Short code, unique within its entity", example: "PB0001" }) code!: string;
  @ApiProperty({ description: "Name the tree shows", example: "Kỹ thuật" }) name!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    description: "Department above it; null at the top",
    example: "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d",
  })
  parentId!: string | null;
  @ApiProperty({ nullable: true, type: String, description: "Accounting cost centre code", example: "CC-KT01" }) costCentre!: string | null;
  @ApiProperty({ nullable: true, type: Number, description: "Employee id of the person heading it", example: 7 }) headId!: number | null;
  @ApiProperty({ description: "False once retired" }) active!: boolean;
  @ApiPropertyOptional({ description: "People filed directly under it; lists only" }) headcount?: number;
  @ApiPropertyOptional({ type: PersonRefView, nullable: true, description: "The person heading it; lists only" })
  head?: PersonRefView | null;
  @ApiProperty({ type: String, format: "date-time", description: "When it was opened", example: "2025-11-03T02:00:00.000Z" })
  createdAt!: string;
  @ApiProperty({ type: String, format: "date-time", description: "Last change to the row", example: "2026-05-20T04:30:00.000Z" })
  updatedAt!: string;
}

export class ReorgRowView {
  @ApiProperty({ description: "Employee id", example: 42 }) employeeId!: number;
  @ApiProperty({ description: "Employee code", example: "NV0002" }) code!: string;
  @ApiProperty({ description: "Name as on the employee record", example: "Trần Thị B" }) fullName!: string;
  @ApiProperty({ nullable: true, type: String, description: "Code of the department they sit in now", example: "PB0001" })
  fromDepartment!: string | null;
  @ApiProperty({ nullable: true, type: String, description: "Code of the department they end up in", example: "PB0002" })
  toDepartment!: string | null;
  @ApiProperty({ nullable: true, type: String, description: "Employee code of their manager now", example: "NV0001" })
  fromManager!: string | null;
  @ApiProperty({ nullable: true, type: String, description: "Employee code of their manager after the move", example: "NV0005" })
  toManager!: string | null;
  @ApiProperty({ description: "Their requests still waiting for a decision" }) pendingRequests!: number;
}

export class SightView {
  @ApiProperty({ description: "Employee code of the manager", example: "NV0001" }) managerCode!: string;
  @ApiProperty({
    type: [String],
    description: "Employee codes of the people whose requests this manager stops or starts deciding",
    example: ["NV0002", "NV0003"],
  })
  employees!: string[];
}

export class ReorgPlanView {
  @ApiProperty({ description: "False for a preview; true once the move is written" }) applied!: boolean;
  @ApiProperty({ type: [ReorgRowView], description: "Everyone the move reaches, by code" }) moving!: ReorgRowView[];
  @ApiProperty({ type: [SightView], description: "Managers who stop deciding for some of the people moved" })
  losingSight!: SightView[];
  @ApiProperty({ type: [SightView], description: "Managers who start deciding for some of the people moved" })
  gainingSight!: SightView[];
  @ApiProperty({ description: "Pending requests that pass to a new approver" }) requestsReassigned!: number;
}
