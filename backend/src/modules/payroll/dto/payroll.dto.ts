import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { PayslipState, PeriodState, RunKind, RunState, SettlementKind } from "@prisma/client";
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

export class CreatePeriodDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  legalEntityId?: string;

  @ApiProperty({ example: 2026 })
  @IsInt()
  @Min(2000)
  @Max(2100)
  year!: number;

  @ApiProperty({ example: 3, minimum: 1, maximum: 12 })
  @IsInt()
  @Min(1)
  @Max(12)
  month!: number;

  @ApiPropertyOptional({ example: "2026-04-05" })
  @IsOptional()
  @IsDateString()
  payDate?: string;
}

export class CreateRunDto {
  @ApiProperty()
  @IsUUID()
  periodId!: string;

  @ApiProperty({ enum: RunKind, example: RunKind.REGULAR })
  @IsEnum(RunKind)
  kind!: RunKind;

  @ApiPropertyOptional({ example: "Chay nhap lan 1" })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;

  @ApiPropertyOptional({ description: "Limit the run to one department" })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class LockPeriodDto {
  @ApiPropertyOptional({
    default: false,
    description: "Lock although the checklist still has open items, on record",
  })
  @IsOptional()
  @IsBoolean()
  acceptOpenItems?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class BonusItemDto {
  @ApiProperty({ example: 1 })
  @IsInt()
  @Min(1)
  employeeId!: number;

  @ApiProperty({ example: "TET" })
  @IsString()
  @MaxLength(32)
  code!: string;

  @ApiPropertyOptional({ example: "Thuong Tet 2026" })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;

  @ApiProperty({ example: 20000000 })
  @IsInt()
  @Min(0)
  amount!: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  taxable?: boolean;
}

export class AddBonusDto {
  @ApiProperty({ type: [BonusItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => BonusItemDto)
  items!: BonusItemDto[];
}

export class SettlementItemDto {
  @ApiProperty({ example: 1 })
  @IsInt()
  @Min(1)
  employeeId!: number;

  @ApiProperty({ enum: SettlementKind, example: SettlementKind.SEVERANCE })
  @IsEnum(SettlementKind)
  kind!: SettlementKind;

  @ApiPropertyOptional({ example: "Tro cap thoi viec 3 nam" })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  label?: string;

  @ApiProperty({ example: 15000000, description: "Positive; the sign comes from kind" })
  @IsInt()
  @Min(0)
  amount!: number;

  @ApiPropertyOptional({ default: false, description: "Statutory severance is exempt" })
  @IsOptional()
  @IsBoolean()
  taxable?: boolean;

  @ApiPropertyOptional({ example: "Thoa thuan ngay 20/09" })
  @IsOptional()
  @IsString()
  @MaxLength(240)
  note?: string;
}

export class SetSettlementDto {
  @ApiProperty({ type: [SettlementItemDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SettlementItemDto)
  items!: SettlementItemDto[];
}

/** One period of a company is one row per employee, so this pages like the
 *  other long lists (KEHOACH 9.9 rule 3).
 */
export class ListPayslipsDto extends PaginationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  periodId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(64)
  runId?: string;

  @ApiPropertyOptional()
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
  @ApiPropertyOptional({ enum: ["bank", "ledger"], default: "bank" })
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
  @ApiProperty({ example: 2026 })
  @Type(() => Number)
  @IsInt()
  @Min(2000)
  @Max(2100)
  year!: number;
}

export class PeriodView {
  @ApiProperty() id!: string;
  @ApiProperty({ type: String, nullable: true }) legalEntityId!: string | null;
  @ApiProperty() year!: number;
  @ApiProperty() month!: number;
  @ApiProperty({ enum: PeriodState }) state!: PeriodState;
  @ApiProperty({ example: "2026-09-01" }) startDate!: string;
  @ApiProperty({ example: "2026-09-30" }) endDate!: string;
  @ApiProperty({ type: String, nullable: true }) payDate!: string | null;
  @ApiProperty({ type: String, nullable: true }) lockedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) paidAt!: string | null;
}

export class RunView {
  @ApiProperty() id!: string;
  @ApiProperty() periodId!: string;
  @ApiProperty({ enum: RunKind }) kind!: RunKind;
  @ApiProperty({ enum: RunState }) state!: RunState;
  @ApiProperty({ type: String, nullable: true }) label!: string | null;
  @ApiProperty({ type: String, nullable: true }) departmentId!: string | null;
  @ApiProperty() employeeCount!: number;
  @ApiProperty() doneCount!: number;
  @ApiProperty() failedCount!: number;
  @ApiProperty({ description: "Whole dong as a decimal string" }) grossTotal!: string;
  @ApiProperty({ description: "Whole dong as a decimal string" }) netTotal!: string;
  @ApiProperty({ type: String, nullable: true }) startedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) finishedAt!: string | null;
}

export class PeriodTotalsView {
  @ApiProperty() payslips!: number;
  @ApiProperty() people!: number;
  @ApiProperty({ description: "Whole dong" }) gross!: string;
  @ApiProperty({ description: "Whole dong" }) insuranceEmployee!: string;
  @ApiProperty({ description: "Whole dong" }) insuranceEmployer!: string;
  @ApiProperty({ description: "Whole dong" }) tax!: string;
  @ApiProperty({ description: "Whole dong" }) net!: string;
  @ApiProperty({ description: "Gross plus the employer's insurance, whole dong" }) employerCost!: string;
}

export class ChecklistItemView {
  @ApiProperty({ example: "REQUESTS_PENDING" }) code!: string;
  @ApiProperty() count!: number;
}

export class DeliveryView {
  @ApiProperty() issued!: number;
  @ApiProperty() sent!: number;
}

export class QueuedCount {
  @ApiProperty() queued!: number;
}

export class ItemCount {
  @ApiProperty() items!: number;
}

class PayslipOwner {
  @ApiProperty() id!: number;
  @ApiProperty() code!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty({ type: Object, nullable: true, description: "{ id, name }" }) department!: {
    id: string;
    name: string;
  } | null;
}

class PayslipRunRef {
  @ApiProperty({ enum: RunKind }) kind!: RunKind;
  @ApiProperty({ enum: RunState }) state!: RunState;
}

export class PayslipRowView {
  @ApiProperty() id!: string;
  @ApiProperty() runId!: string;
  @ApiProperty() periodId!: string;
  @ApiProperty() employeeId!: number;
  @ApiProperty({ enum: PayslipState }) state!: PayslipState;
  @ApiProperty() grossPay!: string;
  @ApiProperty() insuranceEmployee!: string;
  @ApiProperty() personalIncomeTax!: string;
  @ApiProperty({ description: "Advances recovered on this payslip, whole dong" }) advance!: string;
  @ApiProperty() netPay!: string;
  @ApiProperty({ type: PayslipOwner }) employee!: PayslipOwner;
  @ApiProperty({ type: PayslipRunRef }) run!: PayslipRunRef;
}

export class PayslipPageView {
  @ApiProperty({ type: [PayslipRowView] }) rows!: PayslipRowView[];
  @ApiProperty() total!: number;
  @ApiProperty() totalIsExact!: boolean;
  @ApiProperty({ type: String, nullable: true }) next!: string | null;
}
