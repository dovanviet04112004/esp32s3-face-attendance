import { ApiProperty } from "@nestjs/swagger";
import { IsDateString } from "class-validator";

export class RangeDto {
  @ApiProperty({ example: "2026-09-01T00:00:00.000Z" })
  @IsDateString()
  from!: string;

  @ApiProperty({ example: "2026-09-30T23:59:59.000Z" })
  @IsDateString()
  to!: string;
}
