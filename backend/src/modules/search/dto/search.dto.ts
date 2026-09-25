import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, MaxLength } from "class-validator";

export const SEARCH_TERM_MAX = 64;

export class SearchQueryDto {
  @ApiPropertyOptional({ maxLength: SEARCH_TERM_MAX, description: "Two characters or more; shorter answers nothing" })
  @IsOptional()
  @IsString()
  @MaxLength(SEARCH_TERM_MAX)
  q?: string;
}

export class HitView {
  @ApiProperty({ enum: ["employee", "department", "request", "payslip"] })
  kind!: string;

  @ApiProperty()
  id!: string;

  @ApiProperty()
  title!: string;

  @ApiProperty({ description: "Codes and dates only; never an amount" })
  detail!: string;

  @ApiProperty({ example: "/employees/12" })
  href!: string;

  @ApiPropertyOptional({ enum: ["LEAVE", "OVERTIME", "ATTENDANCE_FIX", "BUSINESS_TRIP", "REMOTE_WORK"] })
  requestKind?: string;
}
