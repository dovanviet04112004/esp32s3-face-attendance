import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  ValidateNested,
} from "class-validator";

export class TaxBracketDto {
  @ApiPropertyOptional({ example: 10000000, description: "Null on the open-ended top band" })
  @IsOptional()
  @IsInt()
  @Min(0)
  upToAmount?: number;

  @ApiProperty({ example: 500, description: "Basis points: 500 is five per cent" })
  @IsInt()
  @Min(0)
  rateBp!: number;
}

export class CreatePolicyDto {
  @ApiPropertyOptional({ description: "Null applies the policy to every entity" })
  @IsOptional()
  @IsUUID()
  legalEntityId?: string;

  @ApiProperty({ example: "2026-01-01" })
  @IsDateString()
  effectiveFrom!: string;

  @ApiProperty({ example: 15500000 })
  @IsInt()
  @Min(0)
  selfDeduction!: number;

  @ApiProperty({ example: 6200000 })
  @IsInt()
  @Min(0)
  dependentDeduction!: number;

  @ApiProperty({ example: 800 })
  @IsInt()
  @Min(0)
  socialRateBp!: number;

  @ApiProperty({ example: 150 })
  @IsInt()
  @Min(0)
  healthRateBp!: number;

  @ApiProperty({ example: 100 })
  @IsInt()
  @Min(0)
  unemploymentRateBp!: number;

  @ApiProperty({ example: 1750 })
  @IsInt()
  @Min(0)
  employerSocialRateBp!: number;

  @ApiProperty({ example: 300 })
  @IsInt()
  @Min(0)
  employerHealthRateBp!: number;

  @ApiProperty({ example: 100 })
  @IsInt()
  @Min(0)
  employerUnemploymentRateBp!: number;

  @ApiProperty({ example: 2340000 })
  @IsInt()
  @Min(0)
  referenceWage!: number;

  @ApiProperty({ example: 20 })
  @IsInt()
  @Min(1)
  socialCapMultiple!: number;

  @ApiProperty({ example: 5310000 })
  @IsInt()
  @Min(0)
  regionalMinimumWage!: number;

  @ApiProperty({ example: 20 })
  @IsInt()
  @Min(1)
  unemploymentCapMultiple!: number;

  @ApiProperty({ example: 26 })
  @IsInt()
  @Min(1)
  standardDaysPerMonth!: number;

  @ApiProperty({ example: 14, description: "Unpaid working days that exempt the month" })
  @IsInt()
  @Min(0)
  noContributionUnpaidDays!: number;

  @ApiProperty({ example: 15000 })
  @IsInt()
  @Min(0)
  overtimeWeekdayBp!: number;

  @ApiProperty({ example: 20000 })
  @IsInt()
  @Min(0)
  overtimeWeekendBp!: number;

  @ApiProperty({ example: 30000 })
  @IsInt()
  @Min(0)
  overtimeHolidayBp!: number;

  @ApiProperty({ example: 3000 })
  @IsInt()
  @Min(0)
  nightPremiumBp!: number;

  @ApiPropertyOptional({ example: "Nghi quyet 110/2025/UBTVQH15" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiProperty({ type: [TaxBracketDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => TaxBracketDto)
  brackets!: TaxBracketDto[];
}

export class PolicyListQueryDto {
  @ApiPropertyOptional({ description: "Only this entity's rows" })
  @IsOptional()
  @IsUUID()
  legalEntityId?: string;
}

export class EffectivePolicyQueryDto extends PolicyListQueryDto {
  @ApiPropertyOptional({ example: "2026-09-30", description: "Left out, today" })
  @IsOptional()
  @IsDateString()
  on?: string;
}

export class TaxBracketView {
  @ApiProperty() ordinal!: number;
  @ApiProperty({ type: String, nullable: true, description: "Whole dong; null on the top band" })
  upToAmount!: string | null;
  @ApiProperty() rateBp!: number;
}

export class PolicyView {
  @ApiProperty() id!: string;
  @ApiProperty({ type: String, nullable: true }) legalEntityId!: string | null;
  @ApiProperty({ example: "2026-01-01" }) effectiveFrom!: string;
  @ApiProperty() selfDeduction!: string;
  @ApiProperty() dependentDeduction!: string;
  @ApiProperty() socialRateBp!: number;
  @ApiProperty() healthRateBp!: number;
  @ApiProperty() unemploymentRateBp!: number;
  @ApiProperty() employerSocialRateBp!: number;
  @ApiProperty() employerHealthRateBp!: number;
  @ApiProperty() employerUnemploymentRateBp!: number;
  @ApiProperty() referenceWage!: string;
  @ApiProperty() socialCapMultiple!: number;
  @ApiProperty() regionalMinimumWage!: string;
  @ApiProperty() unemploymentCapMultiple!: number;
  @ApiProperty() standardDaysPerMonth!: string;
  @ApiProperty() noContributionUnpaidDays!: number;
  @ApiProperty() overtimeWeekdayBp!: number;
  @ApiProperty() overtimeWeekendBp!: number;
  @ApiProperty() overtimeHolidayBp!: number;
  @ApiProperty() nightPremiumBp!: number;
  @ApiProperty({ type: String, nullable: true }) note!: string | null;
  @ApiProperty({ type: [TaxBracketView] }) brackets!: TaxBracketView[];
}
