import { ApiProperty } from "@nestjs/swagger";
import { IsDateString, IsString, MaxLength } from "class-validator";

export class RangeDto {
  @ApiProperty({ example: "2026-09-01T00:00:00.000Z" })
  @IsDateString()
  from!: string;

  @ApiProperty({ example: "2026-09-30T23:59:59.000Z" })
  @IsDateString()
  to!: string;
}

export class D02QueryDto {
  @ApiProperty({ description: "The entity the filing is for" })
  @IsString()
  @MaxLength(64)
  legalEntityId!: string;

  @ApiProperty({ example: "2026-06-01", description: "Who was on the books that day" })
  @IsDateString()
  on!: string;
}

export class InsuranceRangeDto {
  @ApiProperty({ description: "The entity the filing is for" })
  @IsString()
  @MaxLength(64)
  legalEntityId!: string;

  @ApiProperty({ example: "2026-09-01" })
  @IsDateString()
  from!: string;

  @ApiProperty({ example: "2026-09-30" })
  @IsDateString()
  to!: string;
}
