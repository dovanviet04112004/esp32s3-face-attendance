import { ApiProperty, ApiPropertyOptional, IntersectionType, OmitType, PartialType, PickType } from "@nestjs/swagger";
import { ContractKind, Gender } from "@prisma/client";

import { EMPLOYEE_FIELD_MAX, IMPORT_MAX_BYTES } from "../import.js";
import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator";

import { PaginationDto } from "../../../common/dto/pagination.dto.js";
import { DEVICE_ID } from "../../enrollment/dto/enrollment.dto.js";

export class CreateEmployeeDto {
  @ApiProperty({ description: "Employee code, unique", example: "NV0002", maxLength: EMPLOYEE_FIELD_MAX.code })
  @IsString()
  @MinLength(1)
  @MaxLength(EMPLOYEE_FIELD_MAX.code)
  code!: string;

  @ApiProperty({ description: "Name as on their papers", example: "Trần Thị B", maxLength: EMPLOYEE_FIELD_MAX.fullName })
  @IsString()
  @MinLength(1)
  @MaxLength(EMPLOYEE_FIELD_MAX.fullName)
  fullName!: string;

  @ApiPropertyOptional({
    description: "Department id, from the org tree (KEHOACH 9.3)",
    example: "6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  departmentId?: string;

  @ApiPropertyOptional({
    description: "Which legal entity employs them (KEHOACH 9.20)",
    example: "0e9a7b6c-5d4e-4f3a-8b2c-1d0e9f8a7b6c",
    maxLength: 64,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  legalEntityId?: string;

  @ApiPropertyOptional({ description: "Who approves this person's requests", example: 7 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  managerId?: number;

  @ApiPropertyOptional({
    maxLength: EMPLOYEE_FIELD_MAX.personalEmail,
    description: "Private address; the login and change warnings go there",
    example: "nv0002@example.com",
  })
  @IsOptional()
  @IsEmail()
  @MaxLength(EMPLOYEE_FIELD_MAX.personalEmail)
  personalEmail?: string;

  @ApiPropertyOptional({ maxLength: EMPLOYEE_FIELD_MAX.phone, description: "Contact number", example: "0912345678" })
  @IsOptional()
  @IsString()
  @MaxLength(EMPLOYEE_FIELD_MAX.phone)
  phone?: string;

  @ApiPropertyOptional({ description: "Joined on; leave blank if unknown", example: "2026-10-01" })
  @IsOptional()
  @IsDateString()
  hireDate?: string;

  @ApiPropertyOptional({ description: "Day of birth", example: "1995-04-30" })
  @IsOptional()
  @IsDateString()
  dateOfBirth?: string;

  @ApiPropertyOptional({
    enum: Gender,
    enumName: "Gender",
    description: "As the insurance form records it; left out when unknown",
    example: Gender.FEMALE,
  })
  @IsOptional()
  @IsEnum(Gender)
  gender?: Gender;

  @ApiPropertyOptional({
    maxLength: EMPLOYEE_FIELD_MAX.nationalId,
    description: "Citizen identity card number",
    example: "001095012345",
  })
  @IsOptional()
  @IsString()
  @MaxLength(EMPLOYEE_FIELD_MAX.nationalId)
  nationalId?: string;

  @ApiPropertyOptional({ maxLength: EMPLOYEE_FIELD_MAX.taxCode, description: "Personal tax code", example: "8012345678" })
  @IsOptional()
  @IsString()
  @MaxLength(EMPLOYEE_FIELD_MAX.taxCode)
  taxCode?: string;

  @ApiPropertyOptional({
    description: "Needed by the D02-LT filing (KEHOACH 9.19)",
    maxLength: EMPLOYEE_FIELD_MAX.socialInsuranceNo,
    example: "0123456789",
  })
  @IsOptional()
  @IsString()
  @MaxLength(EMPLOYEE_FIELD_MAX.socialInsuranceNo)
  socialInsuranceNo?: string;

  @ApiPropertyOptional({ maxLength: EMPLOYEE_FIELD_MAX.bankAccount, description: "Salary account number", example: "0071000123456" })
  @IsOptional()
  @IsString()
  @MaxLength(EMPLOYEE_FIELD_MAX.bankAccount)
  bankAccount?: string;

  @ApiPropertyOptional({ maxLength: EMPLOYEE_FIELD_MAX.bankName, description: "Bank holding the salary account", example: "Vietcombank" })
  @IsOptional()
  @IsString()
  @MaxLength(EMPLOYEE_FIELD_MAX.bankName)
  bankName?: string;

  @ApiPropertyOptional({ description: "Job title id, from the catalogue", example: "2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d", maxLength: 64 })
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
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: "null takes them out of every department",
    example: "6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  departmentId?: string | null;

  @ApiPropertyOptional({ type: Number, nullable: true, description: "null leaves them with no manager", example: 7 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  managerId?: number | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: "null clears the job title",
    example: "2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d",
  })
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

/** The directory's filters for the work on its selection bar (KEHOACH 9.20). */
export const ACCOUNT_FILTERS = ["none", "invited", "active", "locked"] as const;
export type AccountFilter = (typeof ACCOUNT_FILTERS)[number];
export const FACE_FILTERS = ["unassigned", "waiting", "enrolled", "noConsent", "noEmail"] as const;
export type FaceFilter = (typeof FACE_FILTERS)[number];
export const SHIFT_FILTERS = ["none", "some"] as const;
export type ShiftFilter = (typeof SHIFT_FILTERS)[number];

export class EmployeeFilterDto {
  @ApiPropertyOptional({ description: "Matches code or full name", maxLength: 64, example: "Trần" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  search?: string;

  @ApiPropertyOptional({
    description: "The department and its whole subtree",
    maxLength: 64,
    example: "6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  departmentId?: string;

  // Boolean("false") is true, so a query string has to be compared, not cast.
  @ApiPropertyOptional({ description: "true for people still working, false for those who left", example: true })
  @IsOptional()
  @Transform(({ value }) => value === true || value === "true")
  @IsBoolean()
  active?: boolean;

  @ApiPropertyOptional({
    enum: ENDINGS,
    enumName: "EmployeeEnding",
    description: "People still working whose active contract ends (a lapsed one too) or whose probation ends within `within` days; soonest first",
    example: "contract",
  })
  @IsOptional()
  @IsIn(ENDINGS)
  ending?: Ending;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: ENDING_WINDOW_MAX_DAYS,
    default: ENDING_WINDOW_DAYS,
    description: "Days ahead an ending counts as coming up; read only with ending",
    example: 60,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(ENDING_WINDOW_MAX_DAYS)
  within?: number;

  @ApiPropertyOptional({
    enum: ACCOUNT_FILTERS,
    enumName: "AccountFilter",
    description: "none: no login; invited: a login whose password was never set; active: in use; locked: switched off",
    example: "none",
  })
  @IsOptional()
  @IsIn(ACCOUNT_FILTERS)
  account?: AccountFilter;

  @ApiPropertyOptional({
    enum: FACE_FILTERS,
    enumName: "FaceFilter",
    description:
      "On approved kiosks: unassigned: on none; waiting: a pair ASSIGNED or RETAKE; enrolled: a pair ENROLLED. " +
      "noConsent: no consent to face data in force; noEmail: no personal email",
    example: "unassigned",
  })
  @IsOptional()
  @IsIn(FACE_FILTERS)
  face?: FaceFilter;

  @ApiPropertyOptional({
    enum: SHIFT_FILTERS,
    enumName: "ShiftFilter",
    description: "Whether a shift assignment covers today in APP_TIMEZONE",
    example: "none",
  })
  @IsOptional()
  @IsIn(SHIFT_FILTERS)
  shift?: ShiftFilter;
}

export class ListEmployeesDto extends IntersectionType(PaginationDto, EmployeeFilterDto) {}

export class ImportCsvDto {
  @ApiProperty({
    description: "The whole file, as text; an xlsx or csv file may come as the raw body instead",
    example: "code,fullName,personalEmail\nNV0002,Trần Thị B,nv0002@example.com",
  })
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

export const FILE_FORMATS = ["xlsx", "csv"] as const;

export class FileFormatDto {
  @ApiPropertyOptional({
    enum: FILE_FORMATS,
    default: "xlsx",
    description: "xlsx with drop-downs for the catalogue columns, or csv with a byte order mark",
  })
  @IsOptional()
  @IsIn(FILE_FORMATS)
  format?: (typeof FILE_FORMATS)[number];
}

export class ExportQueryDto extends IntersectionType(EmployeeFilterDto, FileFormatDto) {}

export class ImportFaultView {
  @ApiProperty({ description: "The line number Excel shows beside it, header included", example: 7 })
  row!: number;

  @ApiProperty({ description: "Column the fault sits in; empty when it is about the whole file", example: "personalEmail" })
  column!: string;

  @ApiProperty({ description: "What is wrong, as a code the client turns into a sentence", example: "EMAIL_INVALID" })
  code!: string;

  @ApiProperty({ description: "The cell or header at fault as read, cut to the column's limit when too long", example: "nv0002@" })
  value!: string;
}

export class ImportChangeView {
  @ApiProperty({ description: "The line number Excel shows beside it", example: 12 })
  row!: number;

  @ApiProperty({ description: "Employee code of the person the line changes", example: "NV0002" })
  code!: string;

  @ApiProperty({ type: [String], description: "Columns given a new value, by name", example: ["phone", "departmentCode"] })
  fields!: string[];

  @ApiProperty({ type: [String], description: "Columns a - emptied, by name", example: ["taxCode"] })
  cleared!: string[];
}

export class ImportReportView {
  @ApiProperty({ description: "True once written; false for a dry run or a file with a fault left" })
  applied!: boolean;

  @ApiProperty({ description: "People lines read from the file" })
  rows!: number;

  @ApiProperty({ description: "People the file adds" })
  toCreate!: number;

  @ApiProperty({ description: "People already here whom the file changes" })
  toUpdate!: number;

  @ApiProperty({ description: "People already here whom the file leaves exactly as they are" })
  unchanged!: number;

  @ApiProperty({ description: "Rows whose pay columns were left alone: the person already has a pay record" })
  payKept!: number;

  @ApiProperty({ description: "Lines that put their person on a shift" })
  shiftsToAssign!: number;

  @ApiProperty({ description: "Paper consents to face data recorded, method PAPER, one audit line each" })
  consentsToRecord!: number;

  @ApiProperty({ type: () => [ImportChangeView], description: "The first 100 people who change; toUpdate counts them all" })
  changes!: ImportChangeView[];

  @ApiProperty({ description: "Pairs put up for capture; one roster bump per kiosk" })
  kiosksToAssign!: number;

  @ApiProperty({ description: "Logins opened, each with a set-password letter after the commit" })
  loginsToOpen!: number;

  @ApiProperty({ type: [ImportFaultView], description: "Block the write" })
  faults!: ImportFaultView[];

  @ApiProperty({ type: [ImportFaultView], description: "Do not block the write; the part they name is skipped" })
  warnings!: ImportFaultView[];
}

export class EmployeeCountsView {
  @ApiProperty({ description: "Still working, under the search and department filters" })
  active!: number;

  @ApiProperty({ description: "Left, under the search and department filters" })
  left!: number;
}

class AccountCountsView {
  @ApiProperty({ description: "Whatever their account" })
  all!: number;

  @ApiProperty({ description: "People with no login" })
  none!: number;

  @ApiProperty({ description: "People whose login never had its password set" })
  invited!: number;

  @ApiProperty({ description: "People whose login is in use" })
  active!: number;

  @ApiProperty({ description: "People whose login is switched off" })
  locked!: number;
}

class FaceCountsView {
  @ApiProperty({ description: "Whatever their face data; the options overlap, so they do not add up to it" })
  all!: number;

  @ApiProperty({ description: "On no approved kiosk" })
  unassigned!: number;

  @ApiProperty({ description: "Paired with an approved kiosk that waits for a capture" })
  waiting!: number;

  @ApiProperty({ description: "Holding a face on an approved kiosk" })
  enrolled!: number;

  @ApiProperty({ description: "No consent to face data in force" })
  noConsent!: number;

  @ApiProperty({ description: "No personal email on the record" })
  noEmail!: number;
}

class ShiftCountsView {
  @ApiProperty({ description: "Whatever their shift" })
  all!: number;

  @ApiProperty({ description: "No shift assignment covers today" })
  none!: number;

  @ApiProperty({ description: "A shift assignment covers today" })
  some!: number;
}

export class ReadinessCountsView {
  @ApiProperty({ type: AccountCountsView, description: "Under every filter sent but account" })
  account!: AccountCountsView;

  @ApiProperty({ type: FaceCountsView, description: "Under every filter sent but face" })
  face!: FaceCountsView;

  @ApiProperty({ type: ShiftCountsView, description: "Under every filter sent but shift" })
  shift!: ShiftCountsView;
}

class CatalogueRefView {
  @ApiProperty({ description: "Id of the department or job title", example: "6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f" }) id!: string;
  @ApiProperty({ description: "Its short code", example: "PB0001" }) code!: string;
  @ApiProperty({ description: "Its display name", example: "Kỹ thuật" }) name!: string;
}

class ManagerRefView {
  @ApiProperty({ description: "The manager's employee id", example: 7 })
  id!: number;

  @ApiProperty({ description: "The manager's employee code", example: "NV0001" })
  code!: string;

  @ApiProperty({ description: "The manager's name as on their record", example: "Nguyễn Văn A" })
  fullName!: string;
}

/** Every column of an employee row, as a create or an update answers it. */
export class EmployeeRecordView {
  @ApiProperty({ description: "Server-assigned employee id", example: 42 })
  id!: number;

  @ApiProperty({ description: "Employee code, unique", example: "NV0002" })
  code!: string;

  @ApiProperty({ description: "Name as on their papers", example: "Trần Thị B" })
  fullName!: string;

  @ApiProperty({ type: String, nullable: true, description: "Entity that employs them", example: "0e9a7b6c-5d4e-4f3a-8b2c-1d0e9f8a7b6c" })
  legalEntityId!: string | null;

  @ApiProperty({ type: String, nullable: true, description: "Department they sit in", example: "6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f" })
  departmentId!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: "Job title from the catalogue",
    example: "2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d",
  })
  jobTitleId!: string | null;

  @ApiProperty({ type: Number, nullable: true, description: "Employee id of the person who approves their requests", example: 7 })
  managerId!: number | null;

  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    description: "First working day, as midnight UTC of that date",
    example: "2026-10-01T00:00:00.000Z",
  })
  hireDate!: Date | null;

  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    description: "Last working day once leaving is recorded, as midnight UTC; null while no leaving is set",
    example: "2026-10-31T00:00:00.000Z",
  })
  leaveDate!: Date | null;

  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    description: "Day of birth, as midnight UTC; null when a manager reads someone else's record",
    example: "1995-04-30T00:00:00.000Z",
  })
  dateOfBirth!: Date | null;

  @ApiProperty({ enum: Gender, enumName: "Gender", nullable: true, description: "As the insurance form records it; null when unknown" })
  gender!: Gender | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: "Private address; the login and change warnings go there",
    example: "nv0002@example.com",
  })
  personalEmail!: string | null;

  @ApiProperty({ type: String, nullable: true, description: "Contact number", example: "0912345678" })
  phone!: string | null;

  @ApiProperty({ description: "Language the server writes their mail in", example: "vi" })
  locale!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: "Citizen identity card number; null when a manager reads someone else's record",
    example: "001095012345",
  })
  nationalId!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: "Personal tax code; null when a manager reads someone else's record",
    example: "8012345678",
  })
  taxCode!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: "Social insurance number; null when a manager reads someone else's record",
    example: "0123456789",
  })
  socialInsuranceNo!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: "Salary account number; null when a manager reads someone else's record",
    example: "0071000123456",
  })
  bankAccount!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: "Bank holding the salary account; null when a manager reads someone else's record",
    example: "Vietcombank",
  })
  bankName!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: "Address of a photo of them; null when none is on file",
    example: "https://hr.example.com/photos/NV0002.jpg",
  })
  photoUrl!: string | null;

  @ApiProperty({ description: "False once the record is closed after the last day" })
  active!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    description: "Recognition model their held face was made with; null while the server holds none",
    example: "recog-f77969e342ab10b4",
  })
  embeddingVersion!: string | null;

  @ApiProperty({ type: String, format: "date-time", description: "When the record was made", example: "2026-09-28T02:00:00.000Z" })
  createdAt!: Date;

  @ApiProperty({ type: String, format: "date-time", description: "Last change to the row", example: "2026-09-30T07:40:00.000Z" })
  updatedAt!: Date;
}

/** A row as the directory and the profile read it, with the catalogue entries and manager it names. */
export class EmployeeView extends EmployeeRecordView {
  @ApiPropertyOptional({ type: String, format: "date", description: "With `ending` only: the end date that put them in the list" })
  endsOn?: string;

  @ApiProperty({ type: CatalogueRefView, nullable: true, description: "The department departmentId names" })
  department!: CatalogueRefView | null;

  @ApiProperty({ type: CatalogueRefView, nullable: true, description: "The job title jobTitleId names" })
  jobTitle!: CatalogueRefView | null;

  @ApiProperty({ type: ManagerRefView, nullable: true, description: "The manager managerId names" })
  manager!: ManagerRefView | null;
}

export class EmployeePage {
  @ApiProperty({ type: [EmployeeView], description: "One page of people, by code; soonest ending first with ending" })
  rows!: EmployeeView[];

  @ApiProperty({ description: "People matching the filters, counted up to the ceiling" })
  total!: number;

  @ApiProperty({ description: "False when counting stopped at the ceiling" })
  totalIsExact!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    description: "Pass back as cursor for the next page; null on the last page",
    example: "eyJzb3J0VmFsdWUiOiJOVjAwNTAiLCJpZCI6IjUwIn0",
  })
  next!: string | null;
}

export class NextCodeView {
  @ApiProperty({
    type: String,
    nullable: true,
    description: "Next number in the series of the newest hire's code, at the same width; null when that code ends in no number",
    example: "NV0051",
  })
  code!: string | null;
}

export class OnboardContractDto {
  @ApiProperty({ enum: ContractKind, enumName: "ContractKind", description: "Term of the contract", example: ContractKind.PROBATION })
  @IsEnum(ContractKind)
  kind!: ContractKind;

  @ApiProperty({ example: "2026-10-01", description: "Their first day; leave is prorated from it" })
  @IsDateString()
  startDate!: string;

  @ApiPropertyOptional({ description: "Absent means indefinite (KEHOACH 9.18)", example: "2027-09-30" })
  @IsOptional()
  @IsDateString()
  endDate?: string;

  @ApiPropertyOptional({ description: "Last day of probation, when there is one", example: "2026-11-30" })
  @IsOptional()
  @IsDateString()
  probationEnd?: string;

  @ApiPropertyOptional({ maxLength: 64, description: "Number printed on the paper contract", example: "HD-2026-014" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  number?: string;
}

export class OnboardPayDto {
  @ApiProperty({ minimum: 0, description: "Monthly base pay, in whole VND", example: 15_000_000 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  baseSalary!: number;

  @ApiProperty({ minimum: 0, example: 15_000_000, description: "What insurance is charged on (KEHOACH 9.6)" })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  insuranceSalary!: number;
}

export class OnboardDto {
  @ApiProperty({
    type: OnboardContractDto,
    description: "The first contract, written as DRAFT until it is signed",
    example: { kind: "PROBATION", startDate: "2026-10-01", probationEnd: "2026-11-30", number: "HD-2026-014" },
  })
  @ValidateNested()
  @Type(() => OnboardContractDto)
  contract!: OnboardContractDto;

  @ApiPropertyOptional({
    type: OnboardPayDto,
    description: "First pay record, from the start date; left out, no pay is written",
    example: { baseSalary: 15_000_000, insuranceSalary: 15_000_000 },
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => OnboardPayDto)
  pay?: OnboardPayDto;

  @ApiPropertyOptional({ default: true, description: "Open this year's leave balances, prorated from the start date", example: true })
  @IsOptional()
  @IsBoolean()
  seedLeave?: boolean;

  @ApiPropertyOptional({ default: true, description: "Start the onboarding checklist that fits their title and department", example: true })
  @IsOptional()
  @IsBoolean()
  startChecklist?: boolean;

  @ApiPropertyOptional({ default: true, description: "Open a login and mail its setup link to their personal email", example: true })
  @IsOptional()
  @IsBoolean()
  openLogin?: boolean;
}

export class SeededLeaveView {
  @ApiProperty({ description: "Leave type code", example: "ANNUAL" })
  code!: string;

  @ApiProperty({ description: "Year the balance covers", example: 2026 })
  year!: number;

  @ApiProperty({ description: "Days granted for what is left of that year, rounded to the half day", example: 3 })
  entitled!: number;
}

export class ChecklistStartView {
  @ApiProperty({ description: "The onboarding run started", example: "7b8c9d0e-1f2a-4b3c-8d4e-5f6a7b8c9d0e" })
  runId!: string;

  @ApiProperty({ description: "Tasks it handed out", example: 8 })
  tasks!: number;
}

export class OnboardingView {
  @ApiProperty({ description: "Employee id", example: 42 })
  employeeId!: number;

  @ApiProperty({ description: "Employee code", example: "NV0002" })
  code!: string;

  @ApiProperty({ description: "The contract's start date, as sent", example: "2026-10-01" })
  startDate!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: "The contract written, or the one already there for that start date",
    example: "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f",
  })
  contractId!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: "The pay record written or already there; null when no pay was sent",
    example: "4b5c6d7e-8f90-4a1b-9c2d-3e4f5a6b7c8d",
  })
  payId!: string | null;

  @ApiProperty({ type: [SeededLeaveView], description: "Balances opened; empty when none was wanted or all were there" })
  leaveSeeded!: SeededLeaveView[];

  @ApiProperty({
    type: ChecklistStartView,
    nullable: true,
    description: "The checklist started; null when not wanted, when no template fits, or when one was started before",
  })
  checklist!: ChecklistStartView | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: "The login opened; null when not wanted or when none could be opened",
    example: "b5f0c3d2-8a41-4e6b-9c2d-7f1e3a5b9c04",
  })
  userId!: string | null;

  @ApiProperty({
    type: [String],
    description: "Codes for the parts left alone, such as CONTRACT_EXISTS, NO_PAY_GIVEN or NO_EMAIL",
    example: ["NO_PAY_GIVEN"],
  })
  skipped!: string[];
}

export class OffboardDto {
  @ApiProperty({
    example: "2026-10-31",
    description: "Their last working day in APP_TIMEZONE; today or earlier closes the record now, a later day only schedules it",
  })
  @IsDateString()
  leaveDate!: string;

  @ApiPropertyOptional({
    maxLength: 500,
    description: "Why they leave; kept in the audit trail",
    example: "Nghỉ việc theo nguyện vọng cá nhân",
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class MoveLeavingDto extends PickType(OffboardDto, ["leaveDate"] as const) {}

class HeldAssetView {
  @ApiProperty({ description: "Asset tag", example: "TS0142" })
  code!: string;

  @ApiProperty({ description: "What the item is", example: "Máy tính xách tay Dell 5430" })
  name!: string;
}

export class OffboardingView {
  @ApiProperty({ description: "Employee id", example: 42 })
  employeeId!: number;

  @ApiProperty({ description: "Employee code", example: "NV0002" })
  code!: string;

  @ApiProperty({ type: String, format: "date", description: "Their last working day", example: "2026-10-31" })
  leaveDate!: string;

  @ApiProperty({ description: "true when the record closed in this call; false when it closes the morning after leaveDate" })
  closed!: boolean;

  @ApiProperty({ type: [HeldAssetView], description: "Issued assets they still hold, by tag" })
  assetsOutstanding!: HeldAssetView[];

  @ApiProperty({ description: "Their requests nobody has decided" })
  requestsPending!: number;

  @ApiProperty({ description: "Paid advances not yet taken back" })
  advancesOutstanding!: number;
}

/** The most people one bulk run takes, named or found by a filter (KEHOACH 9.20). */
export const BULK_MAX = 5_000;

export const SKIP_REASONS = [
  "EMPLOYEE_NOT_FOUND",
  "EMPLOYEE_HAS_LEFT",
  "LEAVING_SCHEDULED",
  "UNCHANGED",
  "DEPARTMENT_OTHER_ENTITY",
  "MANAGER_CYCLE",
  "NO_EMAIL",
  "EMAIL_TAKEN",
  "LOGIN_IN_USE",
  "ACCOUNT_LOCKED",
  "CONSENT_MISSING",
  "ALREADY_ON_KIOSK",
  "ALREADY_ON_SHIFT",
  "SELF",
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export const PLACEMENT_FIELDS = ["jobTitle", "department", "manager", "legalEntity"] as const;
export type PlacementField = (typeof PLACEMENT_FIELDS)[number];

/** Who a bulk run acts on: these ids, or everyone the directory lists under this filter. */
export class BulkSelectionDto {
  @ApiPropertyOptional({
    type: [Number],
    minItems: 1,
    maxItems: BULK_MAX,
    description: "Send this or filter, not both",
    example: [42, 43, 57],
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BULK_MAX)
  @Type(() => Number)
  @IsInt({ each: true })
  @Min(1, { each: true })
  employeeIds?: number[];

  @ApiPropertyOptional({
    type: EmployeeFilterDto,
    description: "The directory's own filter, read in the caller's scope; more than BULK_MAX people is refused",
    example: { departmentId: "6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f", active: true, account: "none" },
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => EmployeeFilterDto)
  filter?: EmployeeFilterDto;
}

export class BulkQueryDto {
  @ApiPropertyOptional({ default: false, description: "False previews, true writes" })
  @IsOptional()
  @Transform(({ value }) => value === true || value === "true")
  @IsBoolean()
  apply?: boolean;
}

export class BulkPlacementDto extends BulkSelectionDto {
  @ApiPropertyOptional({ maxLength: 64, description: "Job title everyone takes", example: "2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  jobTitleId?: string;

  @ApiPropertyOptional({
    maxLength: 64,
    description: "Belongs to each person's legal entity after the change, or they are skipped",
    example: "6c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f",
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  departmentId?: string;

  @ApiPropertyOptional({ description: "Approves their requests from now on; the pending ones follow (KEHOACH 9.4)", example: 7 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  managerId?: number;

  @ApiPropertyOptional({
    maxLength: 64,
    description: "Entity everyone moves to; left out, a department named here brings its own",
    example: "0e9a7b6c-5d4e-4f3a-8b2c-1d0e9f8a7b6c",
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  legalEntityId?: string;
}

export class BulkEnrollDto extends BulkSelectionDto {
  @ApiProperty({ description: "Approved kiosk to put them up on", example: "kiosk-2884859fd3c8" })
  @Matches(DEVICE_ID)
  deviceId!: string;
}

export class BulkOffboardDto extends IntersectionType(BulkSelectionDto, OffboardDto) {}

export class BulkSkipView {
  @ApiProperty({ description: "Employee id the run passed over", example: 42 })
  employeeId!: number;

  @ApiProperty({ type: String, nullable: true, description: "Employee code; empty for an id nobody here answers to", example: "NV0002" })
  code!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: "Name as on the employee record; empty for an id nobody here answers to",
    example: "Trần Thị B",
  })
  fullName!: string | null;

  @ApiProperty({ enum: SKIP_REASONS, enumName: "BulkSkipReason", description: "Why the run passes them over" })
  reason!: SkipReason;
}

class PlacementChangeView {
  @ApiProperty({ enum: PLACEMENT_FIELDS, enumName: "PlacementField", description: "Which part of the placement moves" })
  field!: PlacementField;

  @ApiProperty({ type: String, nullable: true, description: "The name held now", example: "Kỹ thuật" })
  from!: string | null;

  @ApiProperty({ type: String, nullable: true, description: "The name held after the change", example: "Kinh doanh" })
  to!: string | null;
}

export class PlacementRowView {
  @ApiProperty({ description: "Employee id", example: 42 })
  employeeId!: number;

  @ApiProperty({ description: "Employee code", example: "NV0002" })
  code!: string;

  @ApiProperty({ description: "Name as on the employee record", example: "Trần Thị B" })
  fullName!: string;

  @ApiProperty({ type: [PlacementChangeView], description: "What moves for this person" })
  changes!: PlacementChangeView[];

  @ApiProperty({ description: "Pending requests that move to the new manager" })
  pendingRequests!: number;
}

export class PlacementPlanView {
  @ApiProperty({ description: "False for a preview; true once written" })
  applied!: boolean;

  @ApiProperty({ type: [PlacementRowView], description: "People the run changes, by code" })
  rows!: PlacementRowView[];

  @ApiProperty({ type: [BulkSkipView], description: "People it passes over, with the reason" })
  skipped!: BulkSkipView[];

  @ApiProperty({ description: "Pending requests that move to the new manager, all rows together" })
  requestsMoved!: number;
}

export class LoginRowView {
  @ApiProperty({ description: "Employee id", example: 42 })
  employeeId!: number;

  @ApiProperty({ description: "Employee code", example: "NV0002" })
  code!: string;

  @ApiProperty({ description: "Name as on the employee record", example: "Trần Thị B" })
  fullName!: string;

  @ApiProperty({ description: "Where the setup link goes", example: "nv0002@example.com" })
  email!: string;

  @ApiProperty({ description: "true mails the link of a login nobody has used yet; false opens the login" })
  resend!: boolean;
}

export class LoginPlanView {
  @ApiProperty({ description: "False for a preview; true once the logins are open and the letters queued" })
  applied!: boolean;

  @ApiProperty({ type: [LoginRowView], description: "People who get a login or a fresh link, by code" })
  rows!: LoginRowView[];

  @ApiProperty({ type: [BulkSkipView], description: "People it passes over, with the reason" })
  skipped!: BulkSkipView[];
}

export class EnrollRowView {
  @ApiProperty({ description: "Employee id", example: 42 })
  employeeId!: number;

  @ApiProperty({ description: "Employee code", example: "NV0002" })
  code!: string;

  @ApiProperty({ description: "Name as on the employee record", example: "Trần Thị B" })
  fullName!: string;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: "What the person's last message carries; empty in a preview",
    example: 128,
  })
  rosterVersion!: number | null;

  @ApiProperty({
    description: "true: the kiosk is sent the face the server holds on its model; false: it asks for a capture (KEHOACH 7.5)",
  })
  heldFace!: boolean;
}

export class EnrollPlanView {
  @ApiProperty({ description: "False for a preview; true once the kiosk's roster moved" })
  applied!: boolean;

  @ApiProperty({ description: "Kiosk the run puts people up on", example: "kiosk-2884859fd3c8" })
  deviceId!: string;

  @ApiProperty({ type: [EnrollRowView], description: "People put up for capture, by code" })
  rows!: EnrollRowView[];

  @ApiProperty({ type: [BulkSkipView], description: "People it passes over, with the reason" })
  skipped!: BulkSkipView[];

  @ApiProperty({ description: "The kiosk's roster counter after the run", example: 129 })
  rosterVersion!: number;
}

export class LeavingRowView {
  @ApiProperty({ description: "Employee id", example: 42 })
  employeeId!: number;

  @ApiProperty({ description: "Employee code", example: "NV0002" })
  code!: string;

  @ApiProperty({ description: "Name as on the employee record", example: "Trần Thị B" })
  fullName!: string;

  @ApiProperty({ description: "Issued assets they still hold" })
  assets!: number;

  @ApiProperty({ description: "Their requests nobody has decided" })
  requests!: number;

  @ApiProperty({ description: "Paid advances not yet taken back" })
  advances!: number;
}

export class LeavingPlanView {
  @ApiProperty({ description: "False for a preview; true once the last day is recorded" })
  applied!: boolean;

  @ApiProperty({ type: String, format: "date", description: "The last working day every row gets", example: "2026-10-31" })
  leaveDate!: string;

  @ApiProperty({
    description: "true: the last day is today or behind, so the records close on the people queue right after the write",
  })
  closesNow!: boolean;

  @ApiProperty({ type: [LeavingRowView], description: "People the last day is recorded for, by code" })
  rows!: LeavingRowView[];

  @ApiProperty({ type: [BulkSkipView], description: "People it passes over, with the reason" })
  skipped!: BulkSkipView[];
}
