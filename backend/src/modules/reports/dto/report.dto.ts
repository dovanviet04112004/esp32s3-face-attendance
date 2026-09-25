import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import { IsBoolean, IsDateString, IsIn, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";

import { PaginationDto } from "../../../common/dto/pagination.dto.js";

export class PersonRefView {
  @ApiProperty() id!: number;
  @ApiProperty() code!: string;
  @ApiProperty() fullName!: string;
}

export class TodayCountsView {
  @ApiProperty({ example: "2026-09-25", description: "The calendar day in the business time zone" }) date!: string;
  @ApiProperty({ description: "Active, with a shift in force, on a working day" }) expected!: number;
  @ApiProperty({ description: "At least one punch today" }) present!: number;
  @ApiProperty({ description: "Expected, and the first punch came after start plus grace" }) late!: number;
  @ApiProperty({ description: "Expected, no punch, no approved leave, trip or remote work" }) absentUnexcused!: number;
  @ApiProperty({ description: "An approved leave covers today" }) onLeave!: number;
}

export class TeamTotalsView {
  @ApiProperty() absent!: number;
  @ApiProperty() onLeave!: number;
  @ApiProperty() notPunched!: number;
}

export class TeamTodayView {
  @ApiProperty({ type: [PersonRefView], description: "No punch after the shift's grace; at most 20" })
  absent!: PersonRefView[];
  @ApiProperty({ type: [PersonRefView], description: "At most 20" }) onLeave!: PersonRefView[];
  @ApiProperty({ type: [PersonRefView], description: "No punch yet, grace not over; at most 20" })
  notPunched!: PersonRefView[];
  @ApiProperty({ type: TeamTotalsView }) totals!: TeamTotalsView;
}

export const TEAM_BUCKETS = ["absent", "onLeave", "notPunched"] as const;

export class TeamBucketParams {
  @ApiProperty({ enum: TEAM_BUCKETS })
  @IsIn(TEAM_BUCKETS)
  bucket!: (typeof TEAM_BUCKETS)[number];
}

export class PersonRefPage {
  @ApiProperty({ type: [PersonRefView] }) rows!: PersonRefView[];
  @ApiProperty() total!: number;
  @ApiProperty({ type: String, nullable: true, description: "The last code shown; pass it as cursor" }) next!: string | null;
}

export class ExceptionView {
  @ApiProperty() employeeId!: number;
  @ApiProperty() code!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty({ enum: ["NO_PUNCH", "LATE", "STILL_IN", "QUESTIONABLE_TIME"] })
  reason!: "NO_PUNCH" | "LATE" | "STILL_IN" | "QUESTIONABLE_TIME";
  @ApiProperty({ description: "Minutes past the shift's start plus grace; 0 unless late" }) minutes!: number;
  @ApiProperty({
    type: String,
    nullable: true,
    format: "date-time",
    description: "QUESTIONABLE_TIME only: when the server first heard such a punch today, the hint for correcting it",
  })
  receivedAt!: string | null;
}

export class ExceptionPage {
  @ApiProperty({ type: [ExceptionView] }) rows!: ExceptionView[];
  @ApiProperty() total!: number;
  @ApiProperty({ type: String, nullable: true, description: "The last code shown; pass it as cursor" }) next!: string | null;
}

export class AttendanceTallyView {
  @ApiProperty() employeeId!: number;
  @ApiProperty() code!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty() punches!: number;
  @ApiProperty({ type: String, nullable: true }) firstAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) lastAt!: string | null;
  @ApiProperty() unsyncedClock!: number;
}

export class AttendanceTallyPage {
  @ApiProperty({ type: [AttendanceTallyView] }) rows!: AttendanceTallyView[];
  @ApiProperty() total!: number;
  @ApiPropertyOptional() totalIsExact?: boolean;
  @ApiProperty({ type: String, nullable: true }) next!: string | null;
}

export class TallyTotalsView {
  @ApiProperty() people!: number;
  @ApiProperty() punches!: number;
  @ApiProperty() unsyncedClock!: number;
}

export class ReportQueued {
  @ApiProperty() jobId!: string;
}

export class RangeDto {
  @ApiProperty({ example: "2026-09-01T00:00:00.000Z" })
  @IsDateString()
  from!: string;

  @ApiProperty({ example: "2026-09-30T23:59:59.000Z" })
  @IsDateString()
  to!: string;
}

/** The roll-up is one row per employee, so it pages like any long list. */
export class TallyRangeDto extends PaginationDto {
  @ApiProperty({ example: "2026-09-01T00:00:00.000Z" })
  @IsDateString()
  from!: string;

  @ApiProperty({ example: "2026-09-30T23:59:59.000Z" })
  @IsDateString()
  to!: string;

  @ApiPropertyOptional({ description: "Employee code or full name, any case" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  search?: string;

  @ApiPropertyOptional({ description: "The department and every department under it" })
  @IsOptional()
  @IsUUID()
  departmentId?: string;

  @ApiPropertyOptional({ description: "Only people who came in after their shift's grace on a working day of the range" })
  @IsOptional()
  @Transform(({ value }) => value === true || value === "true")
  @IsBoolean()
  late?: boolean;
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
