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
  @ApiProperty({
    enum: ["employee", "department", "request", "payslip"],
    enumName: "SearchHitKind",
    example: "employee",
    description: "Which list the hit comes from; five of each kind at most",
  })
  kind!: string;

  @ApiProperty({ example: "42", description: "Id within its kind, as text; an employee's is a number" })
  id!: string;

  @ApiProperty({ example: "Nguyễn Văn An", description: "The person's name, or the department's" })
  title!: string;

  @ApiProperty({ example: "NV0042 · Kỹ thuật", description: "Codes and dates only; never an amount" })
  detail!: string;

  @ApiProperty({ example: "/employees/12", description: "Dashboard path that opens the hit" })
  href!: string;

  @ApiPropertyOptional({
    enum: ["LEAVE", "OVERTIME", "ATTENDANCE_FIX", "BUSINESS_TRIP", "REMOTE_WORK"],
    enumName: "RequestKind",
    example: "LEAVE",
    description: "Request hits only: what kind of request",
  })
  requestKind?: string;
}
