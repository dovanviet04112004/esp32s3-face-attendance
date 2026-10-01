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
  @ApiPropertyOptional({
    example: "0a113bd1-4a7b-4a3f-972b-bd493d497c2e",
    description: "Null applies the policy to every entity",
  })
  @IsOptional()
  @IsUUID()
  legalEntityId?: string;

  @ApiProperty({
    example: "2026-01-01",
    description: "First day it applies, YYYY-MM-DD; one policy per entity per date",
  })
  @IsDateString()
  effectiveFrom!: string;

  @ApiProperty({ example: 15500000, description: "Personal relief per month, whole VND" })
  @IsInt()
  @Min(0)
  selfDeduction!: number;

  @ApiProperty({ example: 6200000, description: "Relief per registered dependant per month, whole VND" })
  @IsInt()
  @Min(0)
  dependentDeduction!: number;

  @ApiProperty({ example: 800, description: "Employee social insurance rate, basis points: 800 is 8%" })
  @IsInt()
  @Min(0)
  socialRateBp!: number;

  @ApiProperty({ example: 150, description: "Employee health insurance rate, basis points" })
  @IsInt()
  @Min(0)
  healthRateBp!: number;

  @ApiProperty({ example: 100, description: "Employee unemployment insurance rate, basis points" })
  @IsInt()
  @Min(0)
  unemploymentRateBp!: number;

  @ApiProperty({ example: 1750, description: "Employer social insurance rate, basis points" })
  @IsInt()
  @Min(0)
  employerSocialRateBp!: number;

  @ApiProperty({ example: 300, description: "Employer health insurance rate, basis points" })
  @IsInt()
  @Min(0)
  employerHealthRateBp!: number;

  @ApiProperty({ example: 100, description: "Employer unemployment insurance rate, basis points" })
  @IsInt()
  @Min(0)
  employerUnemploymentRateBp!: number;

  @ApiProperty({ example: 2340000, description: "Reference wage the social and health cap multiplies, whole VND" })
  @IsInt()
  @Min(0)
  referenceWage!: number;

  @ApiProperty({ example: 20, description: "Social and health insurance stop at this many reference wages" })
  @IsInt()
  @Min(1)
  socialCapMultiple!: number;

  @ApiProperty({ example: 5310000, description: "Regional minimum wage the unemployment cap multiplies, whole VND" })
  @IsInt()
  @Min(0)
  regionalMinimumWage!: number;

  @ApiProperty({ example: 20, description: "Unemployment insurance stops at this many regional minimum wages" })
  @IsInt()
  @Min(1)
  unemploymentCapMultiple!: number;

  @ApiProperty({ example: 26, description: "Working days a monthly salary is divided by" })
  @IsInt()
  @Min(1)
  standardDaysPerMonth!: number;

  @ApiProperty({ example: 14, description: "Unpaid working days that exempt the month" })
  @IsInt()
  @Min(0)
  noContributionUnpaidDays!: number;

  @ApiProperty({ example: 15000, description: "Weekday overtime pay, basis points of the hourly rate: 15000 is 150%" })
  @IsInt()
  @Min(0)
  overtimeWeekdayBp!: number;

  @ApiProperty({
    example: 20000,
    description: "Overtime pay on a weekend or unpaid holiday, basis points of the hourly rate",
  })
  @IsInt()
  @Min(0)
  overtimeWeekendBp!: number;

  @ApiProperty({ example: 30000, description: "Paid holiday overtime pay, basis points of the hourly rate" })
  @IsInt()
  @Min(0)
  overtimeHolidayBp!: number;

  @ApiProperty({ example: 3000, description: "Night work premium on top, basis points of the hourly rate" })
  @IsInt()
  @Min(0)
  nightPremiumBp!: number;

  @ApiPropertyOptional({ example: "Nghi quyet 110/2025/UBTVQH15", description: "Where the figures come from" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiProperty({
    type: [TaxBracketDto],
    example: [
      { upToAmount: 10000000, rateBp: 500 },
      { upToAmount: 30000000, rateBp: 1000 },
      { rateBp: 3500 },
    ],
    description: "Progressive bands, lowest first, each ceiling above the last; only the last is open-ended",
  })
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
  @ApiProperty({ example: "4bb7fb6b-6b0f-42af-9b7a-2f2a5c7a23f7", description: "Band id (UUID)" }) id!: string;
  @ApiProperty({ example: "94fa7df5-a364-4a54-9d8c-045acb06b369", description: "Policy the band belongs to" })
  policyId!: string;
  @ApiProperty({ example: 1, description: "Position from the lowest band, from 1" }) ordinal!: number;
  @ApiProperty({ type: String, nullable: true, example: "10000000", description: "Whole dong; null on the top band" })
  upToAmount!: string | null;
  @ApiProperty({ example: 500, description: "Rate on the slice inside the band, basis points: 500 is 5%" })
  rateBp!: number;
}

export class PolicyView {
  @ApiProperty({ example: "94fa7df5-a364-4a54-9d8c-045acb06b369", description: "Policy id (UUID)" }) id!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "0a113bd1-4a7b-4a3f-972b-bd493d497c2e",
    description: "Entity it applies to; null for every entity",
  })
  legalEntityId!: string | null;
  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-01-01T00:00:00.000Z",
    description: "First day it applies, sent as midnight UTC",
  })
  effectiveFrom!: string;
  @ApiProperty({ example: "15500000", description: "Personal relief per month, whole dong as a string" })
  selfDeduction!: string;
  @ApiProperty({ example: "6200000", description: "Relief per dependant per month, whole dong as a string" })
  dependentDeduction!: string;
  @ApiProperty({ example: 800, description: "Employee social insurance rate, basis points" }) socialRateBp!: number;
  @ApiProperty({ example: 150, description: "Employee health insurance rate, basis points" }) healthRateBp!: number;
  @ApiProperty({ example: 100, description: "Employee unemployment insurance rate, basis points" })
  unemploymentRateBp!: number;
  @ApiProperty({ example: 1750, description: "Employer social insurance rate, basis points" })
  employerSocialRateBp!: number;
  @ApiProperty({ example: 300, description: "Employer health insurance rate, basis points" })
  employerHealthRateBp!: number;
  @ApiProperty({ example: 100, description: "Employer unemployment insurance rate, basis points" })
  employerUnemploymentRateBp!: number;
  @ApiProperty({ example: "2340000", description: "Reference wage, whole dong as a string" }) referenceWage!: string;
  @ApiProperty({ example: 20, description: "Social and health insurance stop at this many reference wages" })
  socialCapMultiple!: number;
  @ApiProperty({ example: "5310000", description: "Regional minimum wage, whole dong as a string" })
  regionalMinimumWage!: string;
  @ApiProperty({ example: 20, description: "Unemployment insurance stops at this many regional minimum wages" })
  unemploymentCapMultiple!: number;
  @ApiProperty({ example: "26", description: "Working days a monthly salary is divided by, a decimal string" })
  standardDaysPerMonth!: string;
  @ApiProperty({ example: 14, description: "Unpaid working days that exempt the month from contributions" })
  noContributionUnpaidDays!: number;
  @ApiProperty({ example: 15000, description: "Weekday overtime pay, basis points of the hourly rate" })
  overtimeWeekdayBp!: number;
  @ApiProperty({
    example: 20000,
    description: "Overtime pay on a weekend or unpaid holiday, basis points of the hourly rate",
  })
  overtimeWeekendBp!: number;
  @ApiProperty({ example: 30000, description: "Paid holiday overtime pay, basis points of the hourly rate" })
  overtimeHolidayBp!: number;
  @ApiProperty({ example: 3000, description: "Night work premium, basis points of the hourly rate" })
  nightPremiumBp!: number;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "Nghi quyet 110/2025/UBTVQH15",
    description: "Where the figures come from; null if not given",
  })
  note!: string | null;
  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2025-12-20T02:00:00.000Z",
    description: "When it was added",
  })
  createdAt!: string;
  @ApiProperty({ type: [TaxBracketView], description: "Progressive bands, lowest first" }) brackets!: TaxBracketView[];
}
