import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from "class-validator";

const METHODS = ["PORTAL", "KIOSK", "PAPER"] as const;

export class GrantConsentDto {
  @ApiPropertyOptional({ description: "Left out, the viewer agrees for themselves" })
  @IsOptional()
  @IsInt()
  @Min(1)
  employeeId?: number;

  @ApiPropertyOptional({ description: "Left out, the server stamps the notice it serves" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  noticeVersion?: string;

  @ApiProperty({ enum: METHODS, example: "PORTAL" })
  @IsIn([...METHODS])
  method!: (typeof METHODS)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
