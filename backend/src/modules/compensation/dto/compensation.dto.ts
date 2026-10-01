import { ApiProperty, ApiPropertyOptional, PartialType } from "@nestjs/swagger";
import { DependentRelation, DependentState, PayReason, Role } from "@prisma/client";
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
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from "class-validator";

import { PageMeta, PersonView, QueueQueryDto } from "../../leave/dto/queue.dto.js";

const CODE = /^[A-Z0-9][A-Z0-9_.-]*$/;
const FIRST_D02_ALLOWANCE = 13;
const LAST_D02_ALLOWANCE = 17;
const kMaxAllowances = 20;

export class ListAllowanceTypesDto {
  @ApiPropertyOptional({ default: false, description: "Include retired types" })
  @IsOptional()
  @Transform(({ value }) => value === true || value === "true")
  @IsBoolean()
  all?: boolean;
}

export class CreateAllowanceTypeDto {
  @ApiProperty({ example: "LUNCH", maxLength: 32, description: "Upper case letters, digits, dot, dash" })
  @IsString()
  @Matches(CODE)
  @MaxLength(32)
  code!: string;

  @ApiProperty({ example: "Tiền ăn ca", maxLength: 120, description: "Label pay records copy and payslips print" })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ default: true, example: true, description: "Taxed on the part above taxFreeCap" })
  @IsOptional()
  @IsBoolean()
  taxable?: boolean;

  @ApiPropertyOptional({ default: false, example: false, description: "Counted into the insurance salary" })
  @IsOptional()
  @IsBoolean()
  insurable?: boolean;

  @ApiPropertyOptional({ example: 730000, nullable: true, description: "Dong per month exempt from tax" })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  taxFreeCap?: number | null;

  @ApiPropertyOptional({
    minimum: FIRST_D02_ALLOWANCE,
    maximum: LAST_D02_ALLOWANCE,
    nullable: true,
    example: 13,
    description: "D02-LT column; null keeps it off the filing",
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(FIRST_D02_ALLOWANCE)
  @Max(LAST_D02_ALLOWANCE)
  d02Column?: number | null;
}

export class UpdateAllowanceTypeDto extends PartialType(CreateAllowanceTypeDto) {
  @ApiPropertyOptional({ example: true, description: "False retires it; pay records already written keep their copy" })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class AllowanceDto {
  @ApiProperty({
    example: "4eb003d5-9b2e-440e-9bb1-fa30968513f7",
    description: "The catalogue type; its code, label and rules are copied onto the record",
  })
  @IsUUID()
  allowanceTypeId!: string;

  @ApiProperty({ example: 730000, description: "Dong per month" })
  @IsInt()
  @Min(0)
  amount!: number;
}

export class CreateCompensationDto {
  @ApiProperty({ example: 1, description: "Whose pay; never the writer's own (SELF_DECISION)" })
  @IsInt()
  @Min(1)
  employeeId!: number;

  @ApiProperty({
    example: "2026-04-01",
    description: "First day this pay applies, YYYY-MM-DD; one record per person per day",
  })
  @IsDateString()
  effectiveFrom!: string;

  @ApiProperty({ example: 20000000, description: "Monthly base pay, whole VND" })
  @IsInt()
  @Min(0)
  baseSalary!: number;

  @ApiProperty({ example: 20000000, description: "What contributions are charged on" })
  @IsInt()
  @Min(0)
  insuranceSalary!: number;

  @ApiProperty({
    enum: PayReason,
    enumName: "PayReason",
    example: PayReason.ANNUAL_REVIEW,
    description: "Why pay changed",
  })
  @IsEnum(PayReason)
  reason!: PayReason;

  @ApiPropertyOptional({ example: "Đánh giá cuối năm 2025", description: "Free text kept on the record" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional({
    type: [AllowanceDto],
    example: [{ allowanceTypeId: "4eb003d5-9b2e-440e-9bb1-fa30968513f7", amount: 730000 }],
    description: "One row per type",
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(kMaxAllowances)
  @ValidateNested({ each: true })
  @Type(() => AllowanceDto)
  allowances?: AllowanceDto[];
}

export class BulkRaiseDto {
  @ApiPropertyOptional({
    example: "6aef5afe-433e-4daa-9ece-c33b41d3a660",
    description: "Everybody in this department and every department under it (KEHOACH 9.18 item 6)",
  })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @ApiPropertyOptional({ type: [Number], example: [42, 57], description: "Or exactly these people" })
  @IsOptional()
  @IsArray()
  @Type(() => Number)
  @IsInt({ each: true })
  employeeIds?: number[];

  @ApiProperty({ example: "2026-07-01", description: "First day the new pay applies, YYYY-MM-DD" })
  @IsDateString()
  effectiveFrom!: string;

  @ApiPropertyOptional({ example: 1000, description: "Basis points: 1000 is ten per cent" })
  @IsOptional()
  @IsInt()
  @Min(0)
  percentBp?: number;

  @ApiPropertyOptional({ example: 1000000, description: "A flat amount instead of a rate" })
  @IsOptional()
  @IsInt()
  @Min(0)
  amount?: number;

  @ApiPropertyOptional({
    default: false,
    example: true,
    description: "True sets the insurance salary to the new base; false or absent sets it to the current base",
  })
  @IsOptional()
  @IsBoolean()
  raiseInsuranceSalary?: boolean;

  @ApiProperty({
    enum: PayReason,
    enumName: "PayReason",
    example: PayReason.ANNUAL_REVIEW,
    description: "Why pay changed, written on every record",
  })
  @IsEnum(PayReason)
  reason!: PayReason;

  @ApiPropertyOptional({ example: "Tăng lương định kỳ tháng 7", description: "Free text written on every record" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class CreateDependentDto {
  @ApiPropertyOptional({ example: 42, description: "Left out, the viewer registers their own" })
  @IsOptional()
  @IsInt()
  @Min(1)
  employeeId?: number;

  @ApiProperty({ example: "Nguyen Van B", description: "The dependant's name as on their papers" })
  @IsString()
  @MaxLength(120)
  fullName!: string;

  @ApiProperty({
    enum: DependentRelation,
    enumName: "DependentRelation",
    example: DependentRelation.CHILD,
    description: "How the dependant is related to the employee",
  })
  @IsEnum(DependentRelation)
  relation!: DependentRelation;

  @ApiPropertyOptional({ example: "2018-05-02", description: "Birth date, YYYY-MM-DD" })
  @IsOptional()
  @IsDateString()
  dateOfBirth?: string;

  @ApiPropertyOptional({ example: "8765432109", description: "The dependant's personal tax code" })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  taxCode?: string;

  @ApiPropertyOptional({ example: "001218004567", description: "Citizen id or birth certificate number" })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  nationalId?: string;

  @ApiProperty({ example: "2026-03-01", description: "First month the deduction applies" })
  @IsDateString()
  fromMonth!: string;

  @ApiPropertyOptional({ example: "2044-05-02", description: "Last month the deduction applies; left out, open-ended" })
  @IsOptional()
  @IsDateString()
  toMonth?: string;
}

export class DecideDependentDto {
  @ApiProperty({ example: true, description: "True makes it ACTIVE, false REJECTED" })
  @IsBoolean()
  approve!: boolean;

  @ApiPropertyOptional({ example: "Thiếu giấy khai sinh", description: "What the desk tells the claimant" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ListDependentsDto extends QueueQueryDto {
  @ApiPropertyOptional({
    enum: DependentState,
    enumName: "DependentState",
    default: DependentState.PENDING,
    description: "Registrations in this state; PENDING is the queue to decide",
  })
  @IsOptional()
  @IsEnum(DependentState)
  state?: DependentState;

  @ApiPropertyOptional({ description: "Narrows to one person inside the viewer's scope" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  employeeId?: number;
}

export class AllowanceTypeView {
  @ApiProperty({
    example: "4eb003d5-9b2e-440e-9bb1-fa30968513f7",
    description: "Allowance type id (UUID)",
  })
  id!: string;
  @ApiProperty({ example: "LUNCH", description: "Unique code; pay records copy it" }) code!: string;
  @ApiProperty({ example: "Tiền ăn ca", description: "Label pay records copy and payslips print" }) name!: string;
  @ApiProperty({ example: true, description: "Taxed on the part above taxFreeCap" }) taxable!: boolean;
  @ApiProperty({ example: false, description: "Counted into the insurance salary" }) insurable!: boolean;
  @ApiProperty({
    nullable: true,
    type: String,
    example: "730000",
    description: "Decimal dong per month exempt from tax; null for no exemption",
  })
  taxFreeCap!: string | null;
  @ApiProperty({ nullable: true, type: Number, example: 13, description: "D02-LT column 13 to 17; null keeps it off" })
  d02Column!: number | null;
  @ApiProperty({ example: true, description: "False once retired: no new pay record may pick it" }) active!: boolean;
  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-01-05T02:00:00.000Z",
    description: "When it was added",
  })
  createdAt!: string;
  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-03-10T04:20:00.000Z",
    description: "When it last changed",
  })
  updatedAt!: string;
}

export class AllowanceView {
  @ApiProperty({ example: "45fd0d03-90f5-4c60-98f7-7c3d5ca193a6", description: "Allowance row id (UUID)" }) id!: string;
  @ApiProperty({ example: "c17e50d0-091f-41f4-b29b-92be52fec112", description: "Pay record it belongs to" })
  recordId!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    example: "4eb003d5-9b2e-440e-9bb1-fa30968513f7",
    description: "Catalogue type it was copied from; null once that type is deleted",
  })
  typeId!: string | null;
  @ApiProperty({
    example: "LUNCH",
    description: "Code copied from the type when the record was written",
  })
  code!: string;
  @ApiProperty({ example: "Tiền ăn ca", description: "Label copied from the type when the record was written" })
  label!: string;
  @ApiProperty({ example: "730000", description: "Decimal dong" }) amount!: string;
  @ApiProperty({ example: true, description: "Taxed above taxFreeCap, as the type said on writing" }) taxable!: boolean;
  @ApiProperty({
    example: false,
    description: "Counted into the insurance salary, as the type said",
  })
  insurable!: boolean;
  @ApiProperty({
    nullable: true,
    type: String,
    example: "730000",
    description: "Decimal dong per month exempt from tax; null for no exemption",
  })
  taxFreeCap!: string | null;
  @ApiProperty({ nullable: true, type: Number, example: 13, description: "D02-LT column 13 to 17; null keeps it off" })
  d02Column!: number | null;
}

export class PayRecordView {
  @ApiProperty({ example: "c17e50d0-091f-41f4-b29b-92be52fec112", description: "Pay record id (UUID)" }) id!: string;
  @ApiProperty({ example: 42, description: "Whose pay" }) employeeId!: number;
  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-04-01T00:00:00.000Z",
    description: "First day this pay applies, sent as midnight UTC",
  })
  effectiveFrom!: string;
  @ApiProperty({ example: "20000000", description: "Decimal dong" }) baseSalary!: string;
  @ApiProperty({ example: "20000000", description: "Decimal dong" }) insuranceSalary!: string;
  @ApiProperty({
    enum: PayReason,
    enumName: "PayReason",
    example: PayReason.ANNUAL_REVIEW,
    description: "Why pay changed",
  })
  reason!: PayReason;
  @ApiProperty({
    nullable: true,
    type: String,
    example: "Đánh giá cuối năm 2025",
    description: "Free text; null if none",
  })
  note!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    example: "ab35f74f-dd47-4ad6-8e4c-fb243e7ac176",
    description: "Account that wrote it; null once that account is gone",
  })
  createdById!: string | null;
  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-03-25T07:45:00.000Z",
    description: "When it was written",
  })
  createdAt!: string;
  @ApiProperty({ type: [AllowanceView], description: "Fixed allowances paid with it" }) allowances!: AllowanceView[];
}

export class RaisePreviewView {
  @ApiProperty({ example: 42, description: "Employee id" }) employeeId!: number;
  @ApiProperty({ example: "NV0042", description: "Employee code" }) code!: string;
  @ApiProperty({ example: "Nguyễn Văn An", description: "Name as on the employee record" }) fullName!: string;
  @ApiProperty({ example: "20000000", description: "Base pay in force on effectiveFrom, whole dong as a string" })
  currentBase!: string;
  @ApiProperty({ example: "22000000", description: "Base pay the raise would write, whole dong as a string" })
  nextBase!: string;
}

export class RaiseWrittenView {
  @ApiProperty({
    example: 37,
    description: "Pay records written; a person already holding one on that date is skipped",
  })
  written!: number;
}

export class DependentView {
  @ApiProperty({ example: "e71fa2d2-7ccc-4591-b9df-5b734e951e94", description: "Registration id (UUID)" }) id!: string;
  @ApiProperty({ example: 42, description: "Employee who claims the deduction" }) employeeId!: number;
  @ApiProperty({ example: "Nguyen Van B", description: "The dependant's name" }) fullName!: string;
  @ApiProperty({
    enum: DependentRelation,
    enumName: "DependentRelation",
    example: DependentRelation.CHILD,
    description: "How the dependant is related to the employee",
  })
  relation!: DependentRelation;
  @ApiProperty({
    nullable: true,
    type: String,
    format: "date-time",
    example: "2018-05-02T00:00:00.000Z",
    description: "Birth date, sent as midnight UTC; null if not given",
  })
  dateOfBirth!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    example: "8765432109",
    description: "The dependant's tax code; null if none",
  })
  taxCode!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    example: "001218004567",
    description: "Citizen id or birth certificate number; null if none",
  })
  nationalId!: string | null;
  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-03-01T00:00:00.000Z",
    description: "First month the deduction applies, sent as midnight UTC",
  })
  fromMonth!: string;
  @ApiProperty({
    nullable: true,
    type: String,
    format: "date-time",
    example: "2044-05-02T00:00:00.000Z",
    description: "Last month the deduction applies; null when open-ended",
  })
  toMonth!: string | null;
  @ApiProperty({
    enum: DependentState,
    enumName: "DependentState",
    example: DependentState.PENDING,
    description: "Only ACTIVE deducts",
  })
  state!: DependentState;
  @ApiProperty({
    nullable: true,
    type: String,
    example: "ab35f74f-dd47-4ad6-8e4c-fb243e7ac176",
    description: "Account that decided it; null while pending",
  })
  decidedById!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    format: "date-time",
    example: "2026-03-05T02:30:00.000Z",
    description: "When it was decided; null while pending",
  })
  decidedAt!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    example: "Thiếu giấy khai sinh",
    description: "What the desk wrote; null if nothing",
  })
  decisionNote!: string | null;
  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-03-02T09:00:00.000Z",
    description: "When it was registered",
  })
  createdAt!: string;
  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-03-05T02:30:00.000Z",
    description: "When it last changed",
  })
  updatedAt!: string;
}

export class QueuedDependentView extends DependentView {
  @ApiProperty({ type: PersonView, description: "Employee who claims the deduction" }) employee!: PersonView;
}

export class DependentPageView extends PageMeta {
  @ApiProperty({
    type: [QueuedDependentView],
    description: "Registrations in the state asked for, oldest first by default",
  })
  rows!: QueuedDependentView[];
}

/** Roles that write pay: payroll runs pay but does not set it (KEHOACH 9.4). */
export const PAY_WRITERS: readonly Role[] = [Role.ADMIN, Role.HR];
