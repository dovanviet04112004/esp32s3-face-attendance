import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { RunKind } from "@prisma/client";
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
} from "class-validator";

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
