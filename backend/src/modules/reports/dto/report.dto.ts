import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { ContractKind } from "@prisma/client";
import { Transform } from "class-transformer";
import { IsBoolean, IsDateString, IsIn, IsOptional, IsString, IsUUID, MaxLength } from "class-validator";

import { PaginationDto } from "../../../common/dto/pagination.dto.js";

const EXCEPTION_REASONS = ["NO_PUNCH", "LATE", "STILL_IN", "QUESTIONABLE_TIME"] as const;
const CHANGE_REASONS = ["HIRED", "LEFT", "UNPAID_14", "SALARY_UP", "SALARY_DOWN"] as const;

export class PersonRefView {
  @ApiProperty({ example: 42, description: "Employee id" }) id!: number;
  @ApiProperty({ example: "NV0042", description: "Employee code" }) code!: string;
  @ApiProperty({ example: "Nguyễn Văn An", description: "Name as on the employee record" }) fullName!: string;
}

export class TodayCountsView {
  @ApiProperty({ example: "2026-09-25", description: "The calendar day in the business time zone" }) date!: string;
  @ApiProperty({ example: 118, description: "Active, with a shift in force, on a working day" }) expected!: number;
  @ApiProperty({ example: 104, description: "At least one punch today" }) present!: number;
  @ApiProperty({ example: 6, description: "Expected, and the first punch came after start plus grace" }) late!: number;
  @ApiProperty({ example: 3, description: "Expected, no punch, no approved leave, trip or remote work" })
  absentUnexcused!: number;
  @ApiProperty({ example: 5, description: "An approved leave covers today" }) onLeave!: number;
}

export class TeamTotalsView {
  @ApiProperty({ example: 3, description: "How many are absent in all; the list stops at twenty" }) absent!: number;
  @ApiProperty({ example: 5, description: "How many are on leave in all; the list stops at twenty" }) onLeave!: number;
  @ApiProperty({ example: 2, description: "How many have not punched yet in all; the list stops at twenty" })
  notPunched!: number;
}

export class TeamTodayView {
  @ApiProperty({ type: [PersonRefView], description: "No punch after the shift's grace; at most 20" })
  absent!: PersonRefView[];
  @ApiProperty({ type: [PersonRefView], description: "At most 20" }) onLeave!: PersonRefView[];
  @ApiProperty({ type: [PersonRefView], description: "No punch yet, grace not over; at most 20" })
  notPunched!: PersonRefView[];
  @ApiProperty({ type: TeamTotalsView, description: "How many each list holds in full" }) totals!: TeamTotalsView;
}

export const TEAM_BUCKETS = ["absent", "onLeave", "notPunched"] as const;

export class TeamBucketParams {
  @ApiProperty({
    enum: TEAM_BUCKETS,
    enumName: "TeamBucket",
    description: "Which of today's lists to page through",
  })
  @IsIn(TEAM_BUCKETS)
  bucket!: (typeof TEAM_BUCKETS)[number];
}

export class PersonRefPage {
  @ApiProperty({
    type: [PersonRefView],
    description: "This page of the list, by employee code",
  })
  rows!: PersonRefView[];
  @ApiProperty({ example: 37, description: "Everybody in the list, whatever page this is" }) total!: number;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "NV0042",
    description: "The last code shown; pass it as cursor",
  })
  next!: string | null;
}

export class ExceptionView {
  @ApiProperty({ example: 42, description: "Employee id" }) employeeId!: number;
  @ApiProperty({ example: "NV0042", description: "Employee code" }) code!: string;
  @ApiProperty({ example: "Nguyễn Văn An", description: "Name as on the employee record" }) fullName!: string;
  @ApiProperty({
    enum: EXCEPTION_REASONS,
    enumName: "ExceptionReason",
    example: "LATE",
    description: "Why the person is listed today; the client turns it into a sentence",
  })
  reason!: "NO_PUNCH" | "LATE" | "STILL_IN" | "QUESTIONABLE_TIME";
  @ApiProperty({
    example: 12,
    description: "Minutes past the shift's start plus grace; 0 unless late",
  })
  minutes!: number;
  @ApiProperty({
    type: String,
    nullable: true,
    format: "date-time",
    example: "2026-09-25T01:15:42.000Z",
    description: "QUESTIONABLE_TIME only: when the server first heard such a punch today, the hint for correcting it",
  })
  receivedAt!: string | null;
}

export class ExceptionPage {
  @ApiProperty({ type: [ExceptionView], description: "This page of today's exceptions, by employee code" })
  rows!: ExceptionView[];
  @ApiProperty({ example: 14, description: "Every exception today, whatever page this is" }) total!: number;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "NV0042",
    description: "The last code shown; pass it as cursor",
  })
  next!: string | null;
}

class ExpiringView {
  @ApiProperty({ example: "467a1985-370a-4578-92e4-2b29e5f06535", description: "Contract id (UUID)" })
  contractId!: string;
  @ApiProperty({ example: 42, description: "Employee id" }) employeeId!: number;
  @ApiProperty({ example: "NV0042", description: "Employee code" }) code!: string;
  @ApiProperty({ example: "Nguyễn Văn An", description: "Name as on the employee record" }) fullName!: string;
  @ApiProperty({
    enum: ContractKind,
    enumName: "ContractKind",
    example: ContractKind.FIXED_TERM,
    description: "Kind of contract",
  })
  kind!: ContractKind;
  @ApiProperty({
    type: String,
    format: "date",
    example: "2026-10-31",
    description: "Day the term or the probation ends, YYYY-MM-DD",
  })
  endsOn!: string;
  @ApiProperty({ example: 30, description: "Days from today to endsOn; negative once past" }) daysLeft!: number;
}

class ExpiringPileView {
  @ApiProperty({ type: [ExpiringView], description: "Soonest end first" }) rows!: ExpiringView[];
  @ApiProperty({ example: 4, description: "Rows in the pile, counted no further than the cap" }) total!: number;
  @ApiProperty({ example: true, description: "False when the pile was cut at the cap" }) totalIsExact!: boolean;
}

class ExceptionPileView {
  @ApiProperty({ type: [ExceptionView], description: "By employee code" }) rows!: ExceptionView[];
  @ApiProperty({ example: 14, description: "Rows in the pile, counted no further than the cap" }) total!: number;
  @ApiProperty({
    example: true,
    description: "False when the pile was cut at the cap; GET /reports/attention/exceptions has them all",
  })
  totalIsExact!: boolean;
}

export class AttentionView {
  @ApiProperty({
    type: ExpiringPileView,
    description: "Active term contracts ending within the alert window, overdue ones included",
  })
  contractsEnding!: ExpiringPileView;
  @ApiProperty({ type: ExpiringPileView, description: "Probations ending from today to the end of the alert window" })
  probationEnding!: ExpiringPileView;
  @ApiProperty({ type: ExceptionPileView, description: "Today's late, missing, still-in and questionable punches" })
  exceptionsToday!: ExceptionPileView;
}

class InsuranceChangeView {
  @ApiProperty({ example: 42, description: "Employee id" }) employeeId!: number;
  @ApiProperty({ example: "NV0042", description: "Employee code" }) code!: string;
  @ApiProperty({ example: "Nguyễn Văn An", description: "Name as on the employee record" }) fullName!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "7912345678",
    description: "Social insurance number; null when not recorded",
  })
  socialInsuranceNo!: string | null;
  @ApiProperty({
    enum: CHANGE_REASONS,
    enumName: "InsuranceChangeReason",
    example: "SALARY_UP",
    description: "Why the standing moved; UNPAID_14 is a month with too many unpaid days to contribute",
  })
  reason!: string;
  @ApiProperty({
    type: String,
    format: "date",
    example: "2026-09-01",
    description: "Hire, leave or pay date, YYYY-MM-DD; the range's last day for UNPAID_14",
  })
  effectiveFrom!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "12000000",
    description: "Insurance salary before, whole dong; null outside SALARY_UP and SALARY_DOWN, or for a first record",
  })
  fromSalary!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "14000000",
    description: "Insurance salary after, whole dong; null outside SALARY_UP and SALARY_DOWN",
  })
  toSalary!: string | null;
}

export class InsuranceChangesView {
  @ApiProperty({ example: 14, description: "Unpaid working days that stop the month's contribution, from the policy" })
  unpaidDayThreshold!: number;
  @ApiProperty({ type: [InsuranceChangeView], description: "People who started in the range, by code" })
  increases!: InsuranceChangeView[];
  @ApiProperty({
    type: [InsuranceChangeView],
    description: "People who left, then those over the unpaid-day threshold",
  })
  decreases!: InsuranceChangeView[];
  @ApiProperty({
    type: [InsuranceChangeView],
    description: "Insurance salary moves in the range for people not hired in it, by date then code",
  })
  adjustments!: InsuranceChangeView[];
}

export class AttendanceTallyView {
  @ApiProperty({ example: 42, description: "Employee id" }) employeeId!: number;
  @ApiProperty({ example: "NV0042", description: "Employee code" }) code!: string;
  @ApiProperty({ example: "Nguyễn Văn An", description: "Name as on the employee record" }) fullName!: string;
  @ApiProperty({ example: 44, description: "Punches in the range, questionable ones left out" }) punches!: number;
  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    example: "2026-09-01T00:58:03.000Z",
    description: "Earliest punch in the range",
  })
  firstAt!: string | null;
  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    example: "2026-09-30T10:41:27.000Z",
    description: "Latest punch in the range",
  })
  lastAt!: string | null;
  @ApiProperty({ example: 0, description: "Punches stamped by a kiosk clock that had not synced" })
  unsyncedClock!: number;
}

export class AttendanceTallyPage {
  @ApiProperty({ type: [AttendanceTallyView], description: "One row per person, by full name" })
  rows!: AttendanceTallyView[];
  @ApiProperty({
    example: 120,
    description: "People the range reaches, counted no further than the ceiling; with a cursor, this page's rows only",
  })
  total!: number;
  @ApiPropertyOptional({
    example: true,
    description: "False when counting stopped at the ceiling; absent when nothing was counted",
  })
  totalIsExact?: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "eyJzb3J0VmFsdWUiOiJOZ3V54buFbiBWxINuIEFuIiwiaWQiOiI0MiJ9",
    description: "Cursor for the next page, sent back as cursor; null once a page comes back short",
  })
  next!: string | null;
}

export class TallyTotalsView {
  @ApiProperty({ example: 120, description: "People with a punch in the range" }) people!: number;
  @ApiProperty({ example: 5280, description: "Punches in the range, questionable ones left out" }) punches!: number;
  @ApiProperty({ example: 7, description: "Of those, punches stamped by a clock that had not synced" })
  unsyncedClock!: number;
}

export class ReportQueued {
  @ApiProperty({
    example: "1ca8f21e87c421d7373466c86561d7aa1b513e784eacdd8c977f296d29630900",
    description: "Queue job id, a sha256 of the range, so asking again names the same job",
  })
  jobId!: string;
}

export class RangeDto {
  @ApiProperty({ example: "2026-09-01T00:00:00.000Z", description: "Earliest punch time, an ISO instant, included" })
  @IsDateString()
  from!: string;

  @ApiProperty({ example: "2026-09-30T23:59:59.000Z", description: "Latest punch time, an ISO instant, included" })
  @IsDateString()
  to!: string;
}

/** The roll-up is one row per employee, so it pages like any long list. */
export class TallyRangeDto extends PaginationDto {
  @ApiProperty({ example: "2026-09-01T00:00:00.000Z", description: "Earliest punch time, an ISO instant, included" })
  @IsDateString()
  from!: string;

  @ApiProperty({ example: "2026-09-30T23:59:59.000Z", description: "Latest punch time, an ISO instant, included" })
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

  @ApiProperty({ example: "2026-09-01", description: "First day of the range, YYYY-MM-DD, included" })
  @IsDateString()
  from!: string;

  @ApiProperty({ example: "2026-09-30", description: "Last day of the range, YYYY-MM-DD, included" })
  @IsDateString()
  to!: string;
}
