import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { DependentRelation, PayReason } from "@prisma/client";
import { Type } from "class-transformer";
import {
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
  ValidateNested,
} from "class-validator";

export class AllowanceDto {
  @ApiProperty({ example: "LUNCH" })
  @IsString()
  @MaxLength(32)
  code!: string;

  @ApiProperty({ example: "Tien an ca" })
  @IsString()
  @MaxLength(120)
  label!: string;

  @ApiProperty({ example: 730000 })
  @IsInt()
  @Min(0)
  amount!: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  taxable?: boolean;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  insurable?: boolean;
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

  @ApiPropertyOptional({ type: [AllowanceDto] })
  @IsOptional()
  @IsArray()
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
