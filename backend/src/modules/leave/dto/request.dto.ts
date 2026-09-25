import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";

import { DeciderView, PageMeta, PersonView, QueueQueryDto } from "./queue.dto.js";

const KINDS = ["LEAVE", "OVERTIME", "ATTENDANCE_FIX", "BUSINESS_TRIP", "REMOTE_WORK"] as const;
const STATES = ["DRAFT", "PENDING", "APPROVED", "REJECTED", "CANCELLED"] as const;
const DAY_PARTS = ["MORNING", "AFTERNOON"] as const;
const SORTS = ["createdAt", "fromDate"] as const;
const NOTE_MAX = 500;
const ID_MAX = 64;
export const DECIDE_MANY_MAX = 100;

export type RequestSort = (typeof SORTS)[number];

export class SubmitRequestDto {
  @ApiPropertyOptional({
    description: "Minted by the sender; filing it twice returns the same request",
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  clientKey?: string;

  @ApiProperty({ enum: KINDS })
  @IsEnum(KINDS)
  kind!: (typeof KINDS)[number];

  @ApiPropertyOptional({ description: "Required when kind is LEAVE" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  leaveTypeId?: string;

  @ApiProperty({ example: "2026-10-05" })
  @IsDateString()
  fromDate!: string;

  @ApiProperty({ example: "2026-10-07" })
  @IsDateString()
  toDate!: string;

  @ApiPropertyOptional({ description: "Half a day counts as 0.5 and covers one date" })
  @IsOptional()
  @IsBoolean()
  halfDay?: boolean;

  @ApiPropertyOptional({ enum: DAY_PARTS, description: "Which half, when halfDay is set" })
  @IsOptional()
  @IsIn(DAY_PARTS)
  dayPart?: (typeof DAY_PARTS)[number];

  @ApiPropertyOptional({ description: "Minutes, for overtime and corrections; derived from fromAt and toAt when both are sent" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minutes?: number;

  @ApiPropertyOptional({ example: "2026-10-05T17:30:00+07:00", description: "Overtime start, or the claimed punch in" })
  @IsOptional()
  @IsISO8601()
  fromAt?: string;

  @ApiPropertyOptional({ example: "2026-10-05T20:00:00+07:00", description: "Overtime end, or the claimed punch out" })
  @IsOptional()
  @IsISO8601()
  toAt?: string;

  @ApiProperty({ maxLength: 500 })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;

  @ApiPropertyOptional({ description: "A photo backing an attendance correction" })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  attachmentUrl?: string;
}

export class BalanceQueryDto {
  @ApiPropertyOptional({ example: "2026-11-15", description: "Defaults to today" })
  @IsOptional()
  @IsDateString()
  asOf?: string;

  @ApiPropertyOptional({ description: "Whose balance; the caller's own when left out" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  employeeId?: number;
}

export class LeaveDaysQueryDto {
  @ApiProperty({ example: "2026-12-30" })
  @IsDateString()
  fromDate!: string;

  @ApiProperty({ example: "2027-01-03" })
  @IsDateString()
  toDate!: string;

  @ApiPropertyOptional({ description: "Half a day, on one working date" })
  @IsOptional()
  @Transform(({ value }) => value === true || value === "true")
  @IsBoolean()
  halfDay?: boolean;

  @ApiPropertyOptional({ description: "With it, each year also says what is left after this leave" })
  @IsOptional()
  @IsString()
  @MaxLength(ID_MAX)
  leaveTypeId?: string;
}

export class DecideRequestDto {
  @ApiProperty({ description: "True approves it, false turns it down" })
  @IsBoolean()
  approve!: boolean;

  @ApiPropertyOptional({ maxLength: NOTE_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(NOTE_MAX)
  note?: string;
}

export class DecideManyDto {
  @ApiProperty({ type: [String], maxItems: DECIDE_MANY_MAX })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(DECIDE_MANY_MAX)
  @IsString({ each: true })
  @MaxLength(ID_MAX, { each: true })
  ids!: string[];

  @ApiProperty({ description: "True approves them all, false turns them all down" })
  @IsBoolean()
  approve!: boolean;

  @ApiPropertyOptional({ maxLength: NOTE_MAX, description: "One reason for every row; required to turn down" })
  @IsOptional()
  @IsString()
  @MaxLength(NOTE_MAX)
  note?: string;
}

export class ListRequestsDto extends QueueQueryDto {
  @ApiPropertyOptional({ enum: STATES, description: "The inbox reads only PENDING and ignores this" })
  @IsOptional()
  @IsEnum(STATES)
  state?: (typeof STATES)[number];

  @ApiPropertyOptional({ enum: KINDS })
  @IsOptional()
  @IsEnum(KINDS)
  kind?: (typeof KINDS)[number];

  @ApiPropertyOptional({ description: "One person's requests, still inside what the viewer may see" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  employeeId?: number;

  @ApiPropertyOptional({ enum: SORTS, description: "Ledger only; the inbox sorts on filing time" })
  @IsOptional()
  @IsIn(SORTS)
  sort?: RequestSort;
}

export class LeaveTypeRef {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ description: "False: no balance limits it (KEHOACH 9.5)" })
  paid!: boolean;
}

export class RequestView {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  employeeId!: number;

  @ApiProperty({ enum: KINDS })
  kind!: string;

  @ApiProperty({ enum: STATES })
  state!: string;

  @ApiProperty({ nullable: true })
  leaveTypeId!: string | null;

  @ApiProperty({ example: "2026-10-05T00:00:00.000Z" })
  fromDate!: Date;

  @ApiProperty({ example: "2026-10-07T00:00:00.000Z" })
  toDate!: Date;

  @ApiProperty({ nullable: true })
  fromAt!: Date | null;

  @ApiProperty({ nullable: true })
  toAt!: Date | null;

  @ApiProperty()
  halfDay!: boolean;

  @ApiProperty({ enum: DAY_PARTS, nullable: true })
  dayPart!: string | null;

  @ApiProperty({ example: "3", description: "Working days for leave, a decimal sent as a string" })
  days!: string;

  @ApiProperty({ example: "0", description: "The part of days charged to the year after fromDate's" })
  nextYearDays!: string;

  @ApiProperty()
  minutes!: number;

  @ApiProperty()
  reason!: string;

  @ApiProperty({ nullable: true })
  approverId!: number | null;

  @ApiProperty({ nullable: true })
  decidedAt!: Date | null;

  @ApiProperty({ nullable: true })
  decisionNote!: string | null;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty({ type: PersonView })
  employee!: PersonView;

  @ApiProperty({ type: LeaveTypeRef, nullable: true })
  leaveType!: LeaveTypeRef | null;

  @ApiProperty({ type: DeciderView, nullable: true })
  decidedBy!: DeciderView | null;
}

export class InboxRowView extends RequestView {
  @ApiProperty({ description: "Whole days since it was filed" })
  waitedDays!: number;

  @ApiProperty({ nullable: true, description: "Leave only: days left of this kind in fromDate's year once this is granted" })
  balanceAfter!: number | null;

  @ApiProperty({ nullable: true, description: "A request crossing into the next year: that year's balance once granted" })
  nextBalanceAfter!: number | null;

  @ApiProperty({ nullable: true, description: "Leave only: teammates under the same manager off on these dates" })
  overlapCount!: number | null;
}

export class RequestPageView extends PageMeta {
  @ApiProperty({ type: [RequestView] })
  rows!: RequestView[];
}

export class InboxPageView extends PageMeta {
  @ApiProperty({ type: [InboxRowView] })
  rows!: InboxRowView[];
}

export class InboxCountsView {
  @ApiProperty()
  requests!: number;

  @ApiProperty()
  disputes!: number;

  @ApiProperty()
  certificates!: number;

  @ApiProperty()
  profileChanges!: number;

  @ApiProperty()
  dependents!: number;

  @ApiProperty()
  advancesToDecide!: number;

  @ApiProperty()
  advancesToPay!: number;
}

export class SkippedView {
  @ApiProperty()
  id!: string;

  @ApiProperty({ example: "REQUEST_ALREADY_DECIDED" })
  code!: string;
}

export class DecideManyView {
  @ApiProperty({ type: [String] })
  decided!: string[];

  @ApiProperty({ type: [SkippedView] })
  skipped!: SkippedView[];
}

export class BalanceView {
  @ApiProperty()
  leaveTypeId!: string;

  @ApiProperty()
  code!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  paid!: boolean;

  @ApiProperty()
  year!: number;

  @ApiProperty()
  entitled!: number;

  @ApiProperty()
  carriedOver!: number;

  @ApiProperty()
  taken!: number;

  @ApiProperty()
  pending!: number;

  @ApiProperty({ description: "Carried into the next year when this one closed" })
  carriedOut!: number;

  @ApiProperty()
  remaining!: number;

  @ApiProperty({ description: "Days already booked after the chosen day, this year" })
  bookedAfter!: number;
}

export class OverlapView {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  fromDate!: Date;

  @ApiProperty()
  toDate!: Date;

  @ApiProperty({ enum: STATES })
  state!: string;

  @ApiProperty({ type: PersonView })
  employee!: PersonView;
}

export class RequestDetailView extends RequestView {
  @ApiProperty({ type: BalanceView, nullable: true, description: "The balance of this leave kind in fromDate's year" })
  balance!: BalanceView | null;

  @ApiProperty({ type: BalanceView, nullable: true, description: "The next year's, when the request crosses into it" })
  nextBalance!: BalanceView | null;

  @ApiProperty({ type: [OverlapView], description: "Teammates off on the same dates, twenty at most" })
  overlapping!: OverlapView[];

  @ApiProperty({ description: "Whether this viewer may approve or turn it down now" })
  mayDecide!: boolean;
}

export class LeaveDaysPartView {
  @ApiProperty()
  year!: number;

  @ApiProperty({ description: "Working days charged to this year" })
  days!: number;

  @ApiProperty({ nullable: true, description: "What this year keeps afterwards; null without a type, or for an unpaid one" })
  left!: number | null;
}

export class LeaveDaysView {
  @ApiProperty({ description: "Days charged in all: working days, or every day for a calendar-day type" })
  days!: number;

  @ApiProperty({ description: "False for an unpaid type, which no balance limits" })
  limited!: boolean;

  @ApiProperty({ description: "The type counts every calendar day" })
  calendarDays!: boolean;

  @ApiProperty({ type: [LeaveDaysPartView] })
  parts!: LeaveDaysPartView[];
}
