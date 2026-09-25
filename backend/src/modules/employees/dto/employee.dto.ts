import { ApiProperty, ApiPropertyOptional, IntersectionType, OmitType, PartialType } from "@nestjs/swagger";
import { ContractKind, Gender } from "@prisma/client";

import { EMPLOYEE_FIELD_MAX, IMPORT_MAX_BYTES } from "../import.js";
import { Transform, Type } from "class-transformer";
import {
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";

import { PaginationDto } from "../../../common/dto/pagination.dto.js";

export class CreateEmployeeDto {
  @ApiProperty({ example: "NV0002", maxLength: EMPLOYEE_FIELD_MAX.code })
  @IsString()
  @MinLength(1)
  @MaxLength(EMPLOYEE_FIELD_MAX.code)
  code!: string;

  @ApiProperty({ example: "Trần Thị B", maxLength: EMPLOYEE_FIELD_MAX.fullName })
  @IsString()
  @MinLength(1)
  @MaxLength(EMPLOYEE_FIELD_MAX.fullName)
  fullName!: string;

  @ApiPropertyOptional({ description: "Department id, from the org tree (KEHOACH 9.3)" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  departmentId?: string;

  @ApiPropertyOptional({ description: "Which legal entity employs them (KEHOACH 9.20)" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  legalEntityId?: string;

  @ApiPropertyOptional({ description: "Who approves this person's requests" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  managerId?: number;

  @ApiPropertyOptional({ maxLength: EMPLOYEE_FIELD_MAX.personalEmail, example: "nv0002@example.com" })
  @IsOptional()
  @IsEmail()
  @MaxLength(EMPLOYEE_FIELD_MAX.personalEmail)
  personalEmail?: string;

  @ApiPropertyOptional({ maxLength: EMPLOYEE_FIELD_MAX.phone })
  @IsOptional()
  @IsString()
  @MaxLength(EMPLOYEE_FIELD_MAX.phone)
  phone?: string;

  @ApiPropertyOptional({ description: "Joined on; leave blank if unknown" })
  @IsOptional()
  @IsDateString()
  hireDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  dateOfBirth?: string;

  @ApiPropertyOptional({ enum: Gender })
  @IsOptional()
  @IsEnum(Gender)
  gender?: Gender;

  @ApiPropertyOptional({ maxLength: EMPLOYEE_FIELD_MAX.nationalId })
  @IsOptional()
  @IsString()
  @MaxLength(EMPLOYEE_FIELD_MAX.nationalId)
  nationalId?: string;

  @ApiPropertyOptional({ maxLength: EMPLOYEE_FIELD_MAX.taxCode })
  @IsOptional()
  @IsString()
  @MaxLength(EMPLOYEE_FIELD_MAX.taxCode)
  taxCode?: string;

  @ApiPropertyOptional({ description: "Needed by the D02-LT filing (KEHOACH 9.19)", maxLength: EMPLOYEE_FIELD_MAX.socialInsuranceNo })
  @IsOptional()
  @IsString()
  @MaxLength(EMPLOYEE_FIELD_MAX.socialInsuranceNo)
  socialInsuranceNo?: string;

  @ApiPropertyOptional({ maxLength: EMPLOYEE_FIELD_MAX.bankAccount })
  @IsOptional()
  @IsString()
  @MaxLength(EMPLOYEE_FIELD_MAX.bankAccount)
  bankAccount?: string;

  @ApiPropertyOptional({ maxLength: EMPLOYEE_FIELD_MAX.bankName })
  @IsOptional()
  @IsString()
  @MaxLength(EMPLOYEE_FIELD_MAX.bankName)
  bankName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  jobTitleId?: string;
}

/** Where the pay goes, and the address that hears of a change to it, are set when the record
 *  opens and move only through an approval afterwards (KEHOACH 9.17 item 6). Leaving is
 *  POST /employees/:id/offboard, never a field here (KEHOACH 9.14).
 */
export class UpdateEmployeeDto extends OmitType(PartialType(CreateEmployeeDto), [
  "bankAccount",
  "bankName",
  "personalEmail",
  "managerId",
  "departmentId",
  "jobTitleId",
] as const) {
  @ApiPropertyOptional({ type: String, nullable: true, description: "null takes them out of every department" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  departmentId?: string | null;

  @ApiPropertyOptional({ type: Number, nullable: true, description: "null leaves them with no manager" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  managerId?: number | null;

  @ApiPropertyOptional({ type: String, nullable: true, description: "null clears the job title" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  jobTitleId?: string | null;
}

export const ENDINGS = ["contract", "probation"] as const;
export type Ending = (typeof ENDINGS)[number];

/** How far ahead an ending counts as coming up, unless the caller names its own window. */
export const ENDING_WINDOW_DAYS = 30;
const ENDING_WINDOW_MAX_DAYS = 366;

export class EmployeeFilterDto {
  @ApiPropertyOptional({ description: "Matches code or full name", maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  search?: string;

  @ApiPropertyOptional({ description: "The department and its whole subtree", maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  departmentId?: string;

  // Boolean("false") is true, so a query string has to be compared, not cast.
  @ApiPropertyOptional({ description: "true for people still working, false for those who left" })
  @IsOptional()
  @Transform(({ value }) => value === true || value === "true")
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({
    enum: ENDINGS,
    description: "People still working whose active contract ends (a lapsed one too) or whose probation ends within `within` days; soonest first",
  })
  @IsOptional()
  @IsIn(ENDINGS)
  ending?: Ending;

  @ApiPropertyOptional({ minimum: 1, maximum: ENDING_WINDOW_MAX_DAYS, default: ENDING_WINDOW_DAYS })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(ENDING_WINDOW_MAX_DAYS)
  within?: number;
}

export class ListEmployeesDto extends IntersectionType(PaginationDto, EmployeeFilterDto) {}

export class ImportCsvDto {
  @ApiProperty({ description: "The whole file, as text" })
  @IsString()
  @MaxLength(IMPORT_MAX_BYTES)
  csv!: string;
}

export class ImportQueryDto {
  @ApiPropertyOptional({ description: "true writes when the file has no fault; otherwise a dry run" })
  @IsOptional()
  @Transform(({ value }) => value === true || value === "true")
  @IsBoolean()
  apply?: boolean;
}

export class ImportFaultView {
  @ApiProperty({ description: "Line in the file, header counted as 1" })
  row!: number;

  @ApiProperty()
  column!: string;

  @ApiProperty({ example: "EMAIL_INVALID" })
  code!: string;

  @ApiProperty()
  value!: string;
}

export class ImportReportView {
  @ApiProperty()
  applied!: boolean;

  @ApiProperty()
  rows!: number;

  @ApiProperty()
  toCreate!: number;

  @ApiProperty()
  toUpdate!: number;

  @ApiProperty({ description: "Rows whose pay columns were left alone: the person already has a pay record" })
  payKept!: number;

  @ApiProperty({ type: [ImportFaultView] })
  faults!: ImportFaultView[];
}

export class EmployeeCountsView {
  @ApiProperty({ description: "Still working, under the search and department filters" })
  active!: number;

  @ApiProperty({ description: "Left, under the search and department filters" })
  left!: number;
}

class CatalogueRefView {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty()
  name!: string;
}

class ManagerRefView {
  @ApiProperty()
  id!: number;

  @ApiProperty()
  code!: string;

  @ApiProperty()
  fullName!: string;
}

export class EmployeeView {
  @ApiProperty()
  id!: number;

  @ApiPropertyOptional({ type: String, format: "date", description: "With `ending` only: the end date that put them in the list" })
  endsOn?: string;

  @ApiProperty()
  code!: string;

  @ApiProperty()
  fullName!: string;

  @ApiProperty({ type: String, nullable: true })
  legalEntityId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  departmentId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  jobTitleId!: string | null;

  @ApiProperty({ type: Number, nullable: true })
  managerId!: number | null;

  @ApiProperty({ type: String, format: "date", nullable: true })
  hireDate!: Date | null;

  @ApiProperty({ type: String, format: "date", nullable: true })
  leaveDate!: Date | null;

  @ApiProperty({ type: String, format: "date", nullable: true, description: "Empty for a manager reading a report" })
  dateOfBirth!: Date | null;

  @ApiProperty({ enum: Gender, nullable: true })
  gender!: Gender | null;

  @ApiProperty({ type: String, nullable: true })
  personalEmail!: string | null;

  @ApiProperty({ type: String, nullable: true })
  phone!: string | null;

  @ApiProperty({ type: String, nullable: true, description: "Empty for a manager reading a report" })
  nationalId!: string | null;

  @ApiProperty({ type: String, nullable: true, description: "Empty for a manager reading a report" })
  taxCode!: string | null;

  @ApiProperty({ type: String, nullable: true, description: "Empty for a manager reading a report" })
  socialInsuranceNo!: string | null;

  @ApiProperty({ type: String, nullable: true, description: "Empty for a manager reading a report" })
  bankAccount!: string | null;

  @ApiProperty({ type: String, nullable: true, description: "Empty for a manager reading a report" })
  bankName!: string | null;

  @ApiProperty()
  active!: boolean;

  @ApiProperty({ type: CatalogueRefView, nullable: true })
  department!: CatalogueRefView | null;

  @ApiProperty({ type: CatalogueRefView, nullable: true })
  jobTitle!: CatalogueRefView | null;

  @ApiProperty({ type: ManagerRefView, nullable: true })
  manager!: ManagerRefView | null;
}

export class EmployeePage {
  @ApiProperty({ type: [EmployeeView] })
  rows!: EmployeeView[];

  @ApiProperty()
  total!: number;

  @ApiProperty()
  totalIsExact!: boolean;

  @ApiProperty({ type: String, nullable: true })
  next!: string | null;
}

export class OnboardContractDto {
  @ApiProperty({ enum: ContractKind, example: ContractKind.PROBATION })
  @IsEnum(ContractKind)
  kind!: ContractKind;

  @ApiProperty({ example: "2026-10-01", description: "Their first day; leave is prorated from it" })
  @IsDateString()
  startDate!: string;

  @ApiPropertyOptional({ description: "Absent means indefinite (KEHOACH 9.18)" })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  probationEnd?: string;

  @ApiPropertyOptional({ maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  number?: string;
}

export class OnboardPayDto {
  @ApiProperty({ example: 15_000_000 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  baseSalary!: number;

  @ApiProperty({ example: 15_000_000, description: "What insurance is charged on (KEHOACH 9.6)" })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  insuranceSalary!: number;
}

export class OnboardDto {
  @ApiProperty({ type: OnboardContractDto })
  @ValidateNested()
  @Type(() => OnboardContractDto)
  contract!: OnboardContractDto;

  @ApiPropertyOptional({ type: OnboardPayDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => OnboardPayDto)
  pay?: OnboardPayDto;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  seedLeave?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  startChecklist?: boolean;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  openLogin?: boolean;
}

export class OffboardDto {
  @ApiProperty({ example: "2026-10-31", description: "Their last day" })
  @IsDateString()
  leaveDate!: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
