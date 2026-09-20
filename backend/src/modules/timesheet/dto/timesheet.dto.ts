import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsDateString, IsInt, IsOptional, IsUUID, Min } from "class-validator";

export class BuildDaysDto {
  @ApiProperty({ example: "2026-08-01" })
  @IsDateString()
  from!: string;

  @ApiProperty({ example: "2026-08-31" })
  @IsDateString()
  to!: string;
}

export class ListDaysDto {
  @ApiProperty({ example: "2026-08-01" })
  @IsDateString()
  from!: string;

  @ApiProperty({ example: "2026-08-31" })
  @IsDateString()
  to!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  employeeId?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  departmentId?: string;
}
