import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from "class-validator";

const METHODS = ["PORTAL", "KIOSK", "PAPER"] as const;

export class GrantConsentDto {
  @ApiPropertyOptional({ description: "Left out, the viewer agrees for themselves" })
  @IsOptional()
  @IsInt()
  @Min(1)
  employeeId?: number;

  @ApiProperty({ example: "2026-01-v1", description: "Which notice text was agreed to" })
  @IsString()
  @MaxLength(64)
  noticeVersion!: string;

  @ApiProperty({ enum: METHODS, example: "PORTAL" })
  @IsIn([...METHODS])
  method!: (typeof METHODS)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
