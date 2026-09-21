import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsBoolean, IsEnum, IsInt, IsString, MaxLength, Min, IsOptional } from "class-validator";

const STATES = ["PENDING", "APPROVED", "REJECTED", "PAID", "SETTLED", "CANCELLED"] as const;

export class RequestAdvanceDto {
  @ApiProperty({ example: 3000000 })
  @IsInt()
  @Min(1)
  amount!: number;

  @ApiProperty({ example: "Viec gia dinh" })
  @IsString()
  @MaxLength(500)
  reason!: string;
}

export class ListAdvancesDto {
  @ApiPropertyOptional({ enum: STATES })
  @IsOptional()
  @IsEnum(STATES)
  state?: (typeof STATES)[number];
}

export class DecideAdvanceDto {
  @ApiProperty()
  @IsBoolean()
  approve!: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
