import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsBoolean, IsInt, IsString, MaxLength, Min, IsOptional } from "class-validator";

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
