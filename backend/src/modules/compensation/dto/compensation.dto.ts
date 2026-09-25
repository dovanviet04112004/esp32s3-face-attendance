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

  @ApiProperty({ example: "Tiền ăn ca", maxLength: 120 })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  taxable?: boolean;

  @ApiPropertyOptional({ default: false, description: "Counted into the insurance salary" })
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
  @ApiPropertyOptional({ description: "False retires it; pay records already written keep their copy" })
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}

export class AllowanceDto {
  @ApiProperty({ description: "The catalogue type; its code, label and rules are copied onto the record" })
  @IsUUID()
  allowanceTypeId!: string;

  @ApiProperty({ example: 730000, description: "Dong per month" })
  @IsInt()
  @Min(0)
  amount!: number;
}

export class CreateCompensationDto {
  @ApiProperty({ example: 1 })
  @IsInt()
  @Min(1)
  employeeId!: number;

  @ApiProperty({ example: "2026-04-01" })
  @IsDateString()
  effectiveFrom!: string;

  @ApiProperty({ example: 20000000 })
  @IsInt()
  @Min(0)
  baseSalary!: number;

  @ApiProperty({ example: 20000000, description: "What contributions are charged on" })
  @IsInt()
  @Min(0)
  insuranceSalary!: number;

  @ApiProperty({ enum: PayReason, example: PayReason.ANNUAL_REVIEW })
  @IsEnum(PayReason)
  reason!: PayReason;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional({ type: [AllowanceDto], description: "One row per type" })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(kMaxAllowances)
  @ValidateNested({ each: true })
  @Type(() => AllowanceDto)
  allowances?: AllowanceDto[];
}

export class BulkRaiseDto {
  @ApiPropertyOptional({ description: "Everybody in this department" })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @ApiPropertyOptional({ type: [Number], description: "Or exactly these people" })
  @IsOptional()
  @IsArray()
  @Type(() => Number)
  @IsInt({ each: true })
  employeeIds?: number[];

  @ApiProperty({ example: "2026-07-01" })
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

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  raiseInsuranceSalary?: boolean;

  @ApiProperty({ enum: PayReason, example: PayReason.ANNUAL_REVIEW })
  @IsEnum(PayReason)
  reason!: PayReason;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class CreateDependentDto {
  @ApiPropertyOptional({ description: "Left out, the viewer registers their own" })
  @IsOptional()
  @IsInt()
  @Min(1)
  employeeId?: number;

  @ApiProperty({ example: "Nguyen Van B" })
  @IsString()
  @MaxLength(120)
  fullName!: string;

  @ApiProperty({ enum: DependentRelation })
  @IsEnum(DependentRelation)
  relation!: DependentRelation;

  @ApiPropertyOptional({ example: "2018-05-02" })
  @IsOptional()
  @IsDateString()
  dateOfBirth?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(32)
  taxCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(32)
  nationalId?: string;

  @ApiProperty({ example: "2026-03-01", description: "First month the deduction applies" })
  @IsDateString()
  fromMonth!: string;

  @ApiPropertyOptional({ example: "2044-05-02" })
  @IsOptional()
  @IsDateString()
  toMonth?: string;
}

export class DecideDependentDto {
  @ApiProperty()
  @IsBoolean()
  approve!: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ListDependentsDto extends QueueQueryDto {
  @ApiPropertyOptional({ enum: DependentState, default: DependentState.PENDING })
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
  @ApiProperty() id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiProperty() taxable!: boolean;
  @ApiProperty() insurable!: boolean;
  @ApiProperty({ nullable: true, type: String, description: "Decimal dong" }) taxFreeCap!: string | null;
  @ApiProperty({ nullable: true, type: Number }) d02Column!: number | null;
  @ApiProperty() active!: boolean;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class AllowanceView {
  @ApiProperty() id!: string;
  @ApiProperty() recordId!: string;
  @ApiProperty({ nullable: true, type: String }) typeId!: string | null;
  @ApiProperty() code!: string;
  @ApiProperty() label!: string;
  @ApiProperty({ description: "Decimal dong" }) amount!: string;
  @ApiProperty() taxable!: boolean;
  @ApiProperty() insurable!: boolean;
  @ApiProperty({ nullable: true, type: String }) taxFreeCap!: string | null;
  @ApiProperty({ nullable: true, type: Number }) d02Column!: number | null;
}

export class PayRecordView {
  @ApiProperty() id!: string;
  @ApiProperty() employeeId!: number;
  @ApiProperty() effectiveFrom!: string;
  @ApiProperty({ description: "Decimal dong" }) baseSalary!: string;
  @ApiProperty({ description: "Decimal dong" }) insuranceSalary!: string;
  @ApiProperty({ enum: PayReason }) reason!: PayReason;
  @ApiProperty({ nullable: true, type: String }) note!: string | null;
  @ApiProperty({ nullable: true, type: String }) createdById!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty({ type: [AllowanceView] }) allowances!: AllowanceView[];
}

export class RaisePreviewView {
  @ApiProperty() employeeId!: number;
  @ApiProperty() code!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty() currentBase!: string;
  @ApiProperty() nextBase!: string;
}

export class DependentView {
  @ApiProperty() id!: string;
  @ApiProperty() employeeId!: number;
  @ApiProperty() fullName!: string;
  @ApiProperty({ enum: DependentRelation }) relation!: DependentRelation;
  @ApiProperty({ nullable: true, type: String }) dateOfBirth!: string | null;
  @ApiProperty({ nullable: true, type: String }) taxCode!: string | null;
  @ApiProperty({ nullable: true, type: String }) nationalId!: string | null;
  @ApiProperty() fromMonth!: string;
  @ApiProperty({ nullable: true, type: String }) toMonth!: string | null;
  @ApiProperty({ enum: DependentState }) state!: DependentState;
  @ApiProperty({ nullable: true, type: String }) decidedById!: string | null;
  @ApiProperty({ nullable: true, type: String }) decidedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) decisionNote!: string | null;
  @ApiProperty() createdAt!: string;
}

export class QueuedDependentView extends DependentView {
  @ApiProperty({ type: PersonView }) employee!: PersonView;
}

export class DependentPageView extends PageMeta {
  @ApiProperty({ type: [QueuedDependentView] }) rows!: QueuedDependentView[];
}

/** Roles that write pay: payroll runs pay but does not set it (KEHOACH 9.4). */
export const PAY_WRITERS: readonly Role[] = [Role.ADMIN, Role.HR];
