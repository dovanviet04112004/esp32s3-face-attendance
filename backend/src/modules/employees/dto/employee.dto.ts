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

/** The directory's filters for the work on its selection bar (KEHOACH 9.20). */
export const ACCOUNT_FILTERS = ["none", "invited", "active", "locked"] as const;
export type AccountFilter = (typeof ACCOUNT_FILTERS)[number];
export const FACE_FILTERS = ["unassigned", "waiting", "enrolled", "noConsent", "noEmail"] as const;
export type FaceFilter = (typeof FACE_FILTERS)[number];
export const SHIFT_FILTERS = ["none", "some"] as const;
export type ShiftFilter = (typeof SHIFT_FILTERS)[number];

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

  @ApiPropertyOptional({
    enum: ACCOUNT_FILTERS,
    description: "none: no login; invited: a login whose password was never set; active: in use; locked: switched off",
  })
  @IsOptional()
  @IsIn(ACCOUNT_FILTERS)
  account?: AccountFilter;

  @ApiPropertyOptional({
    enum: FACE_FILTERS,
    description:
      "On approved kiosks: unassigned: on none; waiting: a pair ASSIGNED or RETAKE; enrolled: a pair ENROLLED. " +
      "noConsent: no consent to face data in force; noEmail: no personal email",
  })
  @IsOptional()
  @IsIn(FACE_FILTERS)
  face?: FaceFilter;

  @ApiPropertyOptional({ enum: SHIFT_FILTERS, description: "Whether a shift assignment covers today in APP_TIMEZONE" })
  @IsOptional()
  @IsIn(SHIFT_FILTERS)
  shift?: ShiftFilter;
}

export class ListEmployeesDto extends IntersectionType(PaginationDto, EmployeeFilterDto) {}

export class ImportCsvDto {
  @ApiProperty({ description: "The whole file, as text; an xlsx or csv file may come as the raw body instead" })
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
  @ApiPropertyOptional({ enum: FILE_FORMATS, default: "xlsx" })
  @IsOptional()
  @IsIn(FILE_FORMATS)
  format?: (typeof FILE_FORMATS)[number];
}

export class ExportQueryDto extends IntersectionType(EmployeeFilterDto, FileFormatDto) {}

export class ImportFaultView {
  @ApiProperty({ description: "The line number Excel shows beside it, header included" })
  row!: number;

  @ApiProperty()
  column!: string;

  @ApiProperty({ example: "EMAIL_INVALID" })
  code!: string;

  @ApiProperty()
  value!: string;
}

export class ImportChangeView {
  @ApiProperty({ description: "The line number Excel shows beside it" })
  row!: number;

  @ApiProperty()
  code!: string;

  @ApiProperty({ type: [String], description: "Columns given a new value, by name" })
  fields!: string[];

  @ApiProperty({ type: [String], description: "Columns a - emptied, by name" })
  cleared!: string[];
}

export class ImportReportView {
  @ApiProperty()
  applied!: boolean;

  @ApiProperty()
  rows!: number;

  @ApiProperty()
  toCreate!: number;

  @ApiProperty({ description: "People already here whom the file changes" })
  toUpdate!: number;

  @ApiProperty({ description: "People already here whom the file leaves exactly as they are" })
  unchanged!: number;

  @ApiProperty({ description: "Rows whose pay columns were left alone: the person already has a pay record" })
  payKept!: number;

  @ApiProperty()
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

  @ApiProperty()
  none!: number;

  @ApiProperty()
  invited!: number;

  @ApiProperty()
  active!: number;

  @ApiProperty()
  locked!: number;
}

class FaceCountsView {
  @ApiProperty({ description: "Whatever their face data; the options overlap, so they do not add up to it" })
  all!: number;

  @ApiProperty()
  unassigned!: number;

  @ApiProperty()
  waiting!: number;

  @ApiProperty()
  enrolled!: number;

  @ApiProperty()
  noConsent!: number;

  @ApiProperty()
  noEmail!: number;
}

class ShiftCountsView {
  @ApiProperty({ description: "Whatever their shift" })
  all!: number;

  @ApiProperty()
  none!: number;

  @ApiProperty()
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
  @ApiProperty({
    example: "2026-10-31",
    description: "Their last working day in APP_TIMEZONE; today or earlier closes the record now, a later day only schedules it",
  })
  @IsDateString()
  leaveDate!: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

export class MoveLeavingDto extends PickType(OffboardDto, ["leaveDate"] as const) {}

class HeldAssetView {
  @ApiProperty()
  code!: string;

  @ApiProperty()
  name!: string;
}

export class OffboardingView {
  @ApiProperty()
  employeeId!: number;

  @ApiProperty()
  code!: string;

  @ApiProperty({ type: String, format: "date" })
  leaveDate!: string;

  @ApiProperty({ description: "true when the record closed in this call; false when it closes the morning after leaveDate" })
  closed!: boolean;

  @ApiProperty({ type: [HeldAssetView] })
  assetsOutstanding!: HeldAssetView[];

  @ApiProperty()
  requestsPending!: number;

  @ApiProperty()
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
  @ApiPropertyOptional({ type: [Number], minItems: 1, maxItems: BULK_MAX, description: "Send this or filter, not both" })
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
  @ApiPropertyOptional({ maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  jobTitleId?: string;

  @ApiPropertyOptional({ maxLength: 64, description: "Belongs to each person's legal entity after the change, or they are skipped" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  departmentId?: string;

  @ApiPropertyOptional({ description: "Approves their requests from now on; the pending ones follow (KEHOACH 9.4)" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  managerId?: number;

  @ApiPropertyOptional({ maxLength: 64 })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  legalEntityId?: string;
}

export class BulkEnrollDto extends BulkSelectionDto {
  @ApiProperty({ example: "kiosk-2884859fd3c8" })
  @Matches(DEVICE_ID)
  deviceId!: string;
}

export class BulkOffboardDto extends IntersectionType(BulkSelectionDto, OffboardDto) {}

export class BulkSkipView {
  @ApiProperty()
  employeeId!: number;

  @ApiProperty({ type: String, nullable: true, description: "Empty for an id nobody here answers to" })
  code!: string | null;

  @ApiProperty({ type: String, nullable: true })
  fullName!: string | null;

  @ApiProperty({ enum: SKIP_REASONS })
  reason!: SkipReason;
}

class PlacementChangeView {
  @ApiProperty({ enum: PLACEMENT_FIELDS })
  field!: PlacementField;

  @ApiProperty({ type: String, nullable: true, description: "The name held now" })
  from!: string | null;

  @ApiProperty({ type: String, nullable: true })
  to!: string | null;
}

export class PlacementRowView {
  @ApiProperty()
  employeeId!: number;

  @ApiProperty()
  code!: string;

  @ApiProperty()
  fullName!: string;

  @ApiProperty({ type: [PlacementChangeView] })
  changes!: PlacementChangeView[];

  @ApiProperty({ description: "Pending requests that move to the new manager" })
  pendingRequests!: number;
}

export class PlacementPlanView {
  @ApiProperty()
  applied!: boolean;

  @ApiProperty({ type: [PlacementRowView] })
  rows!: PlacementRowView[];

  @ApiProperty({ type: [BulkSkipView] })
  skipped!: BulkSkipView[];

  @ApiProperty()
  requestsMoved!: number;
}

export class LoginRowView {
  @ApiProperty()
  employeeId!: number;

  @ApiProperty()
  code!: string;

  @ApiProperty()
  fullName!: string;

  @ApiProperty({ description: "Where the setup link goes" })
  email!: string;

  @ApiProperty({ description: "true mails the link of a login nobody has used yet; false opens the login" })
  resend!: boolean;
}

export class LoginPlanView {
  @ApiProperty()
  applied!: boolean;

  @ApiProperty({ type: [LoginRowView] })
  rows!: LoginRowView[];

  @ApiProperty({ type: [BulkSkipView] })
  skipped!: BulkSkipView[];
}

export class EnrollRowView {
  @ApiProperty()
  employeeId!: number;

  @ApiProperty()
  code!: string;

  @ApiProperty()
  fullName!: string;

  @ApiProperty({ type: Number, nullable: true, description: "What the person's last message carries; empty in a preview" })
  rosterVersion!: number | null;

  @ApiProperty({
    description: "true: the kiosk is sent the face the server holds on its model; false: it asks for a capture (KEHOACH 7.5)",
  })
  heldFace!: boolean;
}

export class EnrollPlanView {
  @ApiProperty()
  applied!: boolean;

  @ApiProperty()
  deviceId!: string;

  @ApiProperty({ type: [EnrollRowView] })
  rows!: EnrollRowView[];

  @ApiProperty({ type: [BulkSkipView] })
  skipped!: BulkSkipView[];

  @ApiProperty({ description: "The kiosk's roster counter after the run" })
  rosterVersion!: number;
}

export class LeavingRowView {
  @ApiProperty()
  employeeId!: number;

  @ApiProperty()
  code!: string;

  @ApiProperty()
  fullName!: string;

  @ApiProperty({ description: "Issued assets they still hold" })
  assets!: number;

  @ApiProperty({ description: "Their requests nobody has decided" })
  requests!: number;

  @ApiProperty({ description: "Paid advances not yet taken back" })
  advances!: number;
}

export class LeavingPlanView {
  @ApiProperty()
  applied!: boolean;

  @ApiProperty({ type: String, format: "date" })
  leaveDate!: string;

  @ApiProperty({
    description: "true: the last day is today or behind, so the records close on the people queue right after the write",
  })
  closesNow!: boolean;

  @ApiProperty({ type: [LeavingRowView] })
  rows!: LeavingRowView[];

  @ApiProperty({ type: [BulkSkipView] })
  skipped!: BulkSkipView[];
}
