import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { LineKind, PayslipState, PeriodState, RunKind, RunState, SettlementKind } from "@prisma/client";
import { Transform, Type } from "class-transformer";
import {
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";

import { PaginationDto } from "../../../common/dto/pagination.dto.js";
import { DepartmentRef } from "../../leave/dto/queue.dto.js";

const CHECKLIST_CODES = [
  "REQUESTS_PENDING",
  "CORRECTIONS_OPEN",
  "NO_COMPENSATION",
  "PAY_CHANGES",
  "NO_ATTENDANCE_DAYS",
  "NO_LEGAL_ENTITY",
  "LEAVERS_HOLDING_ASSETS",
  "DISPUTES_OVERDUE",
] as const;

export class CreatePeriodDto {
  @ApiPropertyOptional({
    example: "0a113bd1-4a7b-4a3f-972b-bd493d497c2e",
    description: "Entity the period pays; left out, one company-wide period",
  })
  @IsOptional()
  @IsUUID()
  legalEntityId?: string;

  @ApiProperty({ example: 2026, description: "Calendar year of the pay month" })
  @IsInt()
  @Min(2000)
  @Max(2100)
  year!: number;

  @ApiProperty({ example: 3, minimum: 1, maximum: 12, description: "Pay month, 1 for January" })
  @IsInt()
  @Min(1)
  @Max(12)
  month!: number;

  @ApiPropertyOptional({ example: "2026-04-05", description: "Day the money is due to land, YYYY-MM-DD" })
  @IsOptional()
  @IsDateString()
  payDate?: string;
}

export class CreateRunDto {
  @ApiProperty({
    example: "da693adb-e137-44a8-8b1d-2f89ad567a26",
    description: "Period the run calculates; it must be OPEN",
  })
  @IsUUID()
  periodId!: string;

  @ApiProperty({
    enum: RunKind,
    enumName: "RunKind",
    example: RunKind.REGULAR,
    description: "REGULAR pays the month, BONUS the loaded amounts, FINAL_SETTLEMENT what leavers are owed",
  })
  @IsEnum(RunKind)
  kind!: RunKind;

  @ApiPropertyOptional({ example: "Chay nhap lan 1", description: "Name the desk gives the attempt" })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;

  @ApiPropertyOptional({
    example: "6aef5afe-433e-4daa-9ece-c33b41d3a660",
    description: "Limit the run to one department",
  })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @ApiPropertyOptional({ example: "Chạy lại sau khi sửa công tháng 9", description: "Free text kept on the run" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class LockPeriodDto {
  @ApiPropertyOptional({
    default: false,
    example: false,
    description: "Lock although the checklist still has open items, on record",
  })
  @IsOptional()
  @IsBoolean()
  acceptOpenItems?: boolean;

  @ApiPropertyOptional({
    example: "Còn 2 đơn chờ duyệt, chuyển sang kỳ sau",
    description: "Why it was locked as it stands, kept on the period",
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class BonusItemDto {
  @ApiProperty({ example: 1, description: "Employee paid; never the caller (SELF_DECISION)" })
  @IsInt()
  @Min(1)
  employeeId!: number;

  @ApiProperty({ example: "TET", description: "Bonus code; the payslip line reads BONUS_<code>" })
  @IsString()
  @MaxLength(32)
  code!: string;

  @ApiPropertyOptional({ example: "Thuong Tet 2026", description: "Label printed on the payslip line" })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;

  @ApiProperty({ example: 20000000, description: "Whole VND" })
  @IsInt()
  @Min(0)
  amount!: number;

  @ApiPropertyOptional({ default: true, example: true, description: "Counted into taxable income" })
  @IsOptional()
  @IsBoolean()
  taxable?: boolean;
}

export class AddBonusDto {
  @ApiProperty({
    type: [BonusItemDto],
    example: [{ employeeId: 42, code: "TET", label: "Thuong Tet 2026", amount: 20000000, taxable: true }],
    description: "Every amount the run pays; the list replaces what was loaded",
  })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => BonusItemDto)
  items!: BonusItemDto[];
}

export class SettlementItemDto {
  @ApiProperty({ example: 1, description: "Someone whose leave date falls inside the run's period" })
  @IsInt()
  @Min(1)
  employeeId!: number;

  @ApiProperty({
    enum: SettlementKind,
    enumName: "SettlementKind",
    example: SettlementKind.SEVERANCE,
    description: "SEVERANCE is paid to the person; ASSET_OFFSET is withheld from them",
  })
  @IsEnum(SettlementKind)
  kind!: SettlementKind;

  @ApiPropertyOptional({ example: "Tro cap thoi viec 3 nam", description: "Label printed on the payslip line" })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;

  @ApiProperty({ example: 15000000, description: "Positive; the sign comes from kind" })
  @IsInt()
  @Min(0)
  amount!: number;

  @ApiPropertyOptional({ default: false, example: false, description: "Statutory severance is exempt" })
  @IsOptional()
  @IsBoolean()
  taxable?: boolean;

  @ApiPropertyOptional({ example: "Thoa thuan ngay 20/09", description: "What was agreed, for the record" })
  @IsOptional()
  @IsString()
  @MaxLength(240)
  note?: string;
}

export class SetSettlementDto {
  @ApiProperty({
    type: [SettlementItemDto],
    example: [
      { employeeId: 42, kind: "SEVERANCE", label: "Tro cap thoi viec 3 nam", amount: 15000000, taxable: false },
    ],
    description: "Every signed figure for the run; the list replaces what was loaded",
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SettlementItemDto)
  items!: SettlementItemDto[];
}

/** One period of a company is one row per employee, so this pages like the
 *  other long lists (KEHOACH 9.9 rule 3).
 */
export class ListPayslipsDto extends PaginationDto {
  @ApiPropertyOptional({ example: "da693adb-e137-44a8-8b1d-2f89ad567a26", description: "Only this period's payslips" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  periodId?: string;

  @ApiPropertyOptional({ example: "cd6700aa-77c5-4572-b0cd-43c68ff59159", description: "Only this run's payslips" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  runId?: string;

  @ApiPropertyOptional({
    example: 42,
    description: "Only this person's; one whose pay the viewer may not read answers EMPLOYEE_NOT_FOUND",
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  employeeId?: number;

  @ApiPropertyOptional({ description: "Employee code or full name, any case" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  search?: string;

  @ApiPropertyOptional({ description: "Only payslips a lock has issued" })
  @IsOptional()
  @Transform(({ value }) => value === true || value === "true")
  @IsBoolean()
  issued?: boolean;
}

export class ExportQueryDto {
  @ApiPropertyOptional({
    enum: ["bank", "ledger"],
    enumName: "PayrollExportKind",
    default: "bank",
    description: "bank: account and net pay per person; ledger: gross, insurance, tax and net with cost centre",
  })
  @IsOptional()
  @IsIn(["bank", "ledger"])
  kind?: "bank" | "ledger";
}

export class PeriodsQueryDto {
  @ApiPropertyOptional({ description: "Only this entity's periods" })
  @IsOptional()
  @IsUUID()
  legalEntityId?: string;
}

export class TaxYearQueryDto {
  @ApiProperty({ example: 2026, description: "Calendar year the statement covers" })
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year!: number;
}

export class PeriodView {
  @ApiProperty({ example: "da693adb-e137-44a8-8b1d-2f89ad567a26", description: "Period id (UUID)" }) id!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "0a113bd1-4a7b-4a3f-972b-bd493d497c2e",
    description: "Entity it pays; null for a company-wide period",
  })
  legalEntityId!: string | null;
  @ApiProperty({ example: 2026, description: "Calendar year of the pay month" }) year!: number;
  @ApiProperty({ example: 9, description: "Pay month, 1 for January" }) month!: number;
  @ApiProperty({
    enum: PeriodState,
    enumName: "PeriodState",
    example: PeriodState.OPEN,
    description: "OPEN takes runs, LOCKED froze its inputs and issued payslips, PAID went out",
  })
  state!: PeriodState;
  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-09-01T00:00:00.000Z",
    description: "First day of the month, sent as midnight UTC",
  })
  startDate!: string;
  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-09-30T00:00:00.000Z",
    description: "Last day of the month, sent as midnight UTC",
  })
  endDate!: string;
  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    example: "2026-10-05T00:00:00.000Z",
    description: "Day the money is due, sent as midnight UTC; null if not set",
  })
  payDate!: string | null;
  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    example: "2026-10-02T09:30:00.000Z",
    description: "When it was locked; null while open",
  })
  lockedAt!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "ab35f74f-dd47-4ad6-8e4c-fb243e7ac176",
    description: "Account that locked it; null while open",
  })
  lockedById!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "Còn 2 đơn chờ duyệt, chuyển sang kỳ sau",
    description: "What the locker wrote; null if nothing",
  })
  lockNote!: string | null;
  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    example: "2026-10-05T03:00:00.000Z",
    description: "When it was marked paid; null until then",
  })
  paidAt!: string | null;
  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-09-25T02:00:00.000Z",
    description: "When it was opened",
  })
  createdAt!: string;
  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-10-05T03:00:00.000Z",
    description: "When it last changed",
  })
  updatedAt!: string;
}

export class RunView {
  @ApiProperty({ example: "cd6700aa-77c5-4572-b0cd-43c68ff59159", description: "Run id (UUID)" }) id!: string;
  @ApiProperty({ example: "da693adb-e137-44a8-8b1d-2f89ad567a26", description: "Period it calculates" })
  periodId!: string;
  @ApiProperty({ enum: RunKind, enumName: "RunKind", example: RunKind.REGULAR, description: "What the run pays" })
  kind!: RunKind;
  @ApiProperty({
    enum: RunState,
    enumName: "RunState",
    example: RunState.DONE,
    description: "DRAFT until executed, RUNNING while the worker has it, then DONE or FAILED",
  })
  state!: RunState;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "Chay nhap lan 1",
    description: "Name the desk gave it; null if none",
  })
  label!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "6aef5afe-433e-4daa-9ece-c33b41d3a660",
    description: "The one department it covers; null for everybody",
  })
  departmentId!: string | null;
  @ApiProperty({ example: 120, description: "People the run set out to pay" }) employeeCount!: number;
  @ApiProperty({ example: 118, description: "Payslips it wrote so far" }) doneCount!: number;
  @ApiProperty({ example: 2, description: "People it could not pay, such as one without a pay record" })
  failedCount!: number;
  @ApiProperty({ example: "2580000000", description: "Whole dong as a decimal string" }) grossTotal!: string;
  @ApiProperty({ example: "2190000000", description: "Whole dong as a decimal string" }) netTotal!: string;
  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    example: "2026-09-28T08:00:00.000Z",
    description: "When it last started; null if never executed",
  })
  startedAt!: string | null;
  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    example: "2026-09-28T08:02:31.000Z",
    description: "When it last finished or failed; null while running or never run",
  })
  finishedAt!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "ab35f74f-dd47-4ad6-8e4c-fb243e7ac176",
    description: "Account that created it; null once that account is gone",
  })
  createdById!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "Chạy lại sau khi sửa công tháng 9",
    description: "Free text; null if none",
  })
  note!: string | null;
  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-09-28T07:58:10.000Z",
    description: "When it was created",
  })
  createdAt!: string;
}

export class PeriodTotalsView {
  @ApiProperty({ example: 121, description: "Payslips counted" }) payslips!: number;
  @ApiProperty({ example: 118, description: "Distinct people among them" }) people!: number;
  @ApiProperty({ example: "2580000000", description: "Whole dong" }) gross!: string;
  @ApiProperty({ example: "270900000", description: "Whole dong" }) insuranceEmployee!: string;
  @ApiProperty({ example: "567600000", description: "Whole dong" }) insuranceEmployer!: string;
  @ApiProperty({ example: "119100000", description: "Whole dong" }) tax!: string;
  @ApiProperty({ example: "2190000000", description: "Whole dong" }) net!: string;
  @ApiProperty({ example: "3147600000", description: "Gross plus the employer's insurance, whole dong" })
  employerCost!: string;
}

export class ChecklistItemView {
  @ApiProperty({
    enum: CHECKLIST_CODES,
    enumName: "PayrollChecklistCode",
    example: "REQUESTS_PENDING",
    description: "What is unsettled; the client turns it into a sentence",
  })
  code!: string;
  @ApiProperty({ example: 3, description: "How many rows hold it; 0 means clear" }) count!: number;
}

export class DeliveryView {
  @ApiProperty({ example: 118, description: "Payslips the period has issued" }) issued!: number;
  @ApiProperty({ example: 96, description: "Of those, the ones mailed to their owner" }) sent!: number;
}

export class QueuedCount {
  @ApiProperty({ example: 22, description: "Payslips queued for mailing; ones already sent are skipped" })
  queued!: number;
}

export class ItemCount {
  @ApiProperty({ example: 12, description: "Items now loaded on the run, replacing any earlier list" }) items!: number;
}

class PayslipOwner {
  @ApiProperty({ example: 42, description: "Employee id" }) id!: number;
  @ApiProperty({ example: "NV0042", description: "Employee code" }) code!: string;
  @ApiProperty({ example: "Nguyễn Văn An", description: "Name as on the employee record" }) fullName!: string;
  @ApiProperty({ type: DepartmentRef, nullable: true, description: "Where the person sits; null when unplaced" })
  department!: DepartmentRef | null;
}

class PayslipRunRef {
  @ApiProperty({ enum: RunKind, enumName: "RunKind", example: RunKind.REGULAR, description: "What the run paid" })
  kind!: RunKind;
  @ApiProperty({ enum: RunState, enumName: "RunState", example: RunState.DONE, description: "Where the run stands" })
  state!: RunState;
}

class PayslipPeriodRef {
  @ApiProperty({ example: 2026, description: "Calendar year of the pay month" }) year!: number;
  @ApiProperty({ example: 9, description: "Pay month, 1 for January" }) month!: number;
  @ApiProperty({
    enum: PeriodState,
    enumName: "PeriodState",
    example: PeriodState.LOCKED,
    description: "Where the period stands",
  })
  state!: PeriodState;
}

/** A payslip row as stored; every amount is whole dong sent as a decimal string. */
export class PayslipView {
  @ApiProperty({ example: "8f14e45f-ceea-467a-9575-7e4f3c2a1b90", description: "Payslip id (UUID)" }) id!: string;
  @ApiProperty({
    example: "cd6700aa-77c5-4572-b0cd-43c68ff59159",
    description: "Run that calculated it",
  })
  runId!: string;
  @ApiProperty({
    example: "da693adb-e137-44a8-8b1d-2f89ad567a26",
    description: "Period it belongs to",
  })
  periodId!: string;
  @ApiProperty({ example: 42, description: "Whose payslip" }) employeeId!: number;
  @ApiProperty({
    example: "94fa7df5-a364-4a54-9d8c-045acb06b369",
    description: "Payroll policy it was calculated under",
  })
  policyId!: string;
  @ApiProperty({
    enum: PayslipState,
    enumName: "PayslipState",
    example: PayslipState.ISSUED,
    description: "DRAFT until a lock issues it; SENT once mailed, VIEWED once its owner opened it",
  })
  state!: PayslipState;
  @ApiProperty({ example: "21", description: "Workdays worked, a decimal string" }) workedDays!: string;
  @ApiProperty({ example: "1", description: "Days on paid leave, a decimal string" }) paidLeaveDays!: string;
  @ApiProperty({ example: "0", description: "Unpaid leave and absent days, a decimal string" }) unpaidDays!: string;
  @ApiProperty({ example: 10080, description: "Minutes worked in the month" }) workedMinutes!: number;
  @ApiProperty({ example: 150, description: "Overtime minutes paid: each day the lesser of measured and approved" })
  overtimeMinutes!: number;
  @ApiProperty({ example: "21500000", description: "Every earning" }) grossPay!: string;
  @ApiProperty({ example: "20030000", description: "Earnings tax applies to, before insurance and family relief" })
  taxableIncome!: string;
  @ApiProperty({ example: "2257500", description: "Social, health and unemployment insurance withheld" })
  insuranceEmployee!: string;
  @ApiProperty({ example: "4472500", description: "Insurance the employer pays on top" }) insuranceEmployer!: string;
  @ApiProperty({ example: "120000", description: "Personal income tax withheld" }) personalIncomeTax!: string;
  @ApiProperty({ example: "3377500", description: "Every amount withheld: insurance, tax, advances, offsets" })
  deductionsTotal!: string;
  @ApiProperty({ example: "18122500", description: "Gross less everything withheld" }) netPay!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "Vietcombank",
    description: "Bank the pay goes to, copied at lock; null on a draft or when unknown",
  })
  bankName!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "0071001234567",
    description: "Account the pay goes to, copied at lock; null on a draft or when unknown",
  })
  bankAccount!: string | null;
  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    example: "2026-10-02T09:30:00.000Z",
    description: "When a lock issued it; null on a draft",
  })
  issuedAt!: string | null;
  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    example: "2026-10-02T10:05:00.000Z",
    description: "When it was mailed; null until then",
  })
  sentAt!: string | null;
  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    example: "2026-10-03T01:20:00.000Z",
    description: "When its owner first opened it; null until then",
  })
  viewedAt!: string | null;
  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-09-28T08:01:02.000Z",
    description: "When it was calculated",
  })
  createdAt!: string;
  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-10-03T01:20:00.000Z",
    description: "When it last changed",
  })
  updatedAt!: string;
}

export class PayslipRowView extends PayslipView {
  @ApiProperty({ type: PayslipPeriodRef, description: "The pay month and where it stands" }) period!: PayslipPeriodRef;
  @ApiProperty({ example: "3000000", description: "Advances recovered on this payslip, whole dong" }) advance!: string;
  @ApiProperty({ type: PayslipOwner, description: "Whose payslip, with their department" }) employee!: PayslipOwner;
  @ApiProperty({ type: PayslipRunRef, description: "The run that calculated it" }) run!: PayslipRunRef;
}

export class PayslipPageView {
  @ApiProperty({ type: [PayslipRowView], description: "Newest month first, then by employee" }) rows!: PayslipRowView[];
  @ApiProperty({ example: 118, description: "Payslips the filter reaches, counted no further than the ceiling" })
  total!: number;
  @ApiProperty({ example: true, description: "False when counting stopped at the ceiling, so total is a floor" })
  totalIsExact!: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "8f14e45f-ceea-467a-9575-7e4f3c2a1b90",
    description: "Id of the last payslip shown, sent back as cursor; null once a page comes back short",
  })
  next!: string | null;
}

export class PayslipLineView {
  @ApiProperty({ example: "23d1754a-eba9-4234-90e3-a6a62bba5bc5", description: "Line id (UUID)" }) id!: string;
  @ApiProperty({ example: "8f14e45f-ceea-467a-9575-7e4f3c2a1b90", description: "Payslip it belongs to" })
  payslipId!: string;
  @ApiProperty({ example: 1, description: "Position on the payslip, from 1" }) ordinal!: number;
  @ApiProperty({
    enum: LineKind,
    enumName: "LineKind",
    example: LineKind.EARNING,
    description: "EARNING adds to gross, DEDUCTION is withheld; EMPLOYER_COST and INFO move no money for the person",
  })
  kind!: LineKind;
  @ApiProperty({
    example: "BASE",
    description: "Component code, such as BASE, OT_WEEKDAY, BHXH or PIT; an allowance reads ALW_<code>",
  })
  code!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "Tiền ăn ca",
    description: "Text somebody typed, such as an allowance name; null for a standard component",
  })
  label!: string | null;
  @ApiProperty({ example: "19500000", description: "Whole dong as a decimal string" }) amount!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "21",
    description: "Days, minutes or dependants the amount is for, a decimal string; null when none",
  })
  quantity!: string | null;
  @ApiProperty({ type: Number, nullable: true, example: 800, description: "Rate applied in basis points: 800 is 8%" })
  rateBp!: number | null;
}

export class PayslipDetailView extends PayslipView {
  @ApiProperty({ type: [PayslipLineView], description: "Every component, in payslip order" }) lines!: PayslipLineView[];
}

export class PayslipDeltaView {
  @ApiProperty({ example: "OT_WEEKDAY", description: "Component code" }) code!: string;
  @ApiProperty({ example: "450000", description: "Amount on this payslip, whole dong; 0 when absent" })
  thisPeriod!: string;
  @ApiProperty({
    example: "0",
    description: "Amount on the previous payslip of the same run kind, whole dong; 0 when absent",
  })
  lastPeriod!: string;
  @ApiProperty({ example: "450000", description: "This period less the last, whole dong; may be negative" })
  difference!: string;
}

class PayeeRefView {
  @ApiProperty({ example: 42, description: "Employee id" }) id!: number;
  @ApiProperty({ example: "NV0042", description: "Employee code" }) code!: string;
  @ApiProperty({ example: "Nguyễn Văn An", description: "Name as on the employee record" }) fullName!: string;
}

export class BonusRowView {
  @ApiProperty({ example: "334dce61-d868-4f9d-8bc3-c5e0adc93fd5", description: "Bonus item id (UUID)" }) id!: string;
  @ApiProperty({
    example: "cd6700aa-77c5-4572-b0cd-43c68ff59159",
    description: "Bonus run it belongs to",
  })
  runId!: string;
  @ApiProperty({ example: 42, description: "Employee paid" }) employeeId!: number;
  @ApiProperty({ example: "TET", description: "Bonus code; the payslip line reads BONUS_<code>" }) code!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "Thuong Tet 2026",
    description: "Label on the payslip line; null if none",
  })
  label!: string | null;
  @ApiProperty({ example: "20000000", description: "Whole dong as a decimal string" }) amount!: string;
  @ApiProperty({ example: true, description: "Counted into taxable income" }) taxable!: boolean;
  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-01-20T03:00:00.000Z",
    description: "When it was loaded",
  })
  createdAt!: string;
  @ApiProperty({ type: PayeeRefView, description: "Employee paid" }) employee!: PayeeRefView;
}

class SettlementAssetView {
  @ApiProperty({ example: "LT-0031", description: "Asset code" }) code!: string;
  @ApiProperty({ example: "Laptop Dell Latitude 5440", description: "Asset name" }) name!: string;
}

class SettlementEntryView {
  @ApiProperty({
    enum: SettlementKind,
    enumName: "SettlementKind",
    example: SettlementKind.SEVERANCE,
    description: "SEVERANCE is paid to the person; ASSET_OFFSET is withheld from them",
  })
  kind!: SettlementKind;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "Tro cap thoi viec 3 nam",
    description: "Label on the payslip line; null if none",
  })
  label!: string | null;
  @ApiProperty({ example: "15000000", description: "Whole dong as a decimal string" }) amount!: string;
  @ApiProperty({ example: false, description: "Counted into taxable income" }) taxable!: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "Thoa thuan ngay 20/09",
    description: "What was agreed; null if nothing",
  })
  note!: string | null;
}

class SettlementRowView {
  @ApiProperty({ example: 42, description: "Employee id" }) employeeId!: number;
  @ApiProperty({ example: "NV0042", description: "Employee code" }) code!: string;
  @ApiProperty({ example: "Nguyễn Văn An", description: "Name as on the employee record" }) fullName!: string;
  @ApiProperty({
    type: String,
    format: "date",
    nullable: true,
    example: "2026-09-20",
    description: "Last working day, YYYY-MM-DD; inside the period by construction",
  })
  leaveDate!: string | null;
  @ApiProperty({ example: 38, description: "Whole months from hire date to leave date; 0 without a hire date" })
  tenureMonths!: number;
  @ApiProperty({ example: "20000000", description: "Base pay in force at the period's end, whole dong" })
  baseSalary!: string;
  @ApiProperty({ example: "10000000", description: "Half the base pay, whole dong" }) halfMonthPay!: string;
  @ApiProperty({ example: 3.5, description: "Paid leave days still free in the period's year" })
  unusedLeaveDays!: number;
  @ApiProperty({
    example: "2692308",
    description: "The unused days at base pay over the policy's standard days, whole dong",
  })
  leavePayout!: string;
  @ApiProperty({ type: [SettlementAssetView], description: "Assets the person still holds" })
  assetsHeld!: SettlementAssetView[];
  @ApiProperty({ type: [SettlementEntryView], description: "Figures somebody signed for, as loaded" })
  typed!: SettlementEntryView[];
}

export class SettlementSheetView {
  @ApiProperty({ example: "cd6700aa-77c5-4572-b0cd-43c68ff59159", description: "Final settlement run" }) runId!: string;
  @ApiProperty({ example: "da693adb-e137-44a8-8b1d-2f89ad567a26", description: "Period the run belongs to" })
  periodId!: string;
  @ApiProperty({ type: [SettlementRowView], description: "One row per person leaving inside the period" })
  rows!: SettlementRowView[];
}

class TaxYearMonthView {
  @ApiProperty({ example: "da693adb-e137-44a8-8b1d-2f89ad567a26", description: "Period of the payslip" })
  periodId!: string;
  @ApiProperty({ example: 9, description: "Pay month, 1 for January" }) month!: number;
  @ApiProperty({ example: "21500000", description: "Whole dong" }) grossPay!: string;
  @ApiProperty({ example: "20030000", description: "Earnings tax applies to, whole dong" }) taxableIncome!: string;
  @ApiProperty({ example: "2257500", description: "Insurance withheld, whole dong" }) insuranceEmployee!: string;
  @ApiProperty({ example: "15500000", description: "Personal relief applied, whole dong" }) reliefSelf!: string;
  @ApiProperty({ example: "6200000", description: "Dependant relief applied, whole dong" }) reliefDependent!: string;
  @ApiProperty({ example: "150000", description: "Overtime premium left out of tax, whole dong" })
  exemptOvertime!: string;
  @ApiProperty({ example: "120000", description: "Tax withheld, whole dong" }) taxWithheld!: string;
  @ApiProperty({ example: "18122500", description: "Net pay, whole dong" }) netPay!: string;
}

export class TaxYearStatementView {
  @ApiProperty({ example: 42, description: "Employee id" }) employeeId!: number;
  @ApiProperty({ example: "NV0042", description: "Employee code" }) code!: string;
  @ApiProperty({ example: "Nguyễn Văn An", description: "Name as on the employee record" }) fullName!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "8012345678",
    description: "Personal tax code; null if unknown",
  })
  taxCode!: string | null;
  @ApiProperty({ example: 2026, description: "Calendar year covered" }) year!: number;
  @ApiProperty({
    example: "94fa7df5-a364-4a54-9d8c-045acb06b369",
    description: "Policy in force on 31 December, whose bands settle the year",
  })
  policyId!: string;
  @ApiProperty({ type: [TaxYearMonthView], description: "One entry per issued payslip, by month" })
  months!: TaxYearMonthView[];
  @ApiProperty({ example: "258000000", description: "Whole dong" }) grossTotal!: string;
  @ApiProperty({ example: "240360000", description: "Whole dong" }) taxableTotal!: string;
  @ApiProperty({ example: "27090000", description: "Whole dong" }) insuranceTotal!: string;
  @ApiProperty({ example: "186000000", description: "Whole dong" }) reliefSelfTotal!: string;
  @ApiProperty({ example: "74400000", description: "Whole dong" }) reliefDependentTotal!: string;
  @ApiProperty({ example: "1800000", description: "Whole dong" }) exemptOvertimeTotal!: string;
  @ApiProperty({ example: "0", description: "Taxable less insurance and relief, never below 0, whole dong" })
  assessableTotal!: string;
  @ApiProperty({
    example: "0",
    description: "Tax the annual bands charge on assessableTotal, whole dong",
  })
  taxDue!: string;
  @ApiProperty({ example: "1440000", description: "Tax the payslips withheld, whole dong" }) taxWithheld!: string;
  @ApiProperty({ example: "-1440000", description: "Due less withheld; negative is owed back to the person" })
  difference!: string;
}
