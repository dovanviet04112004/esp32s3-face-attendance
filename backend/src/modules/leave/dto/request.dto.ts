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
    example: "2dbf73fd-d71d-4d2a-bacd-0362ce6b4cff",
    description: "Minted by the sender; filing it twice returns the same request",
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  clientKey?: string;

  @ApiProperty({
    enum: KINDS,
    enumName: "RequestKind",
    example: "LEAVE",
    description: "What is asked for; LEAVE spends a balance, OVERTIME and ATTENDANCE_FIX carry minutes",
  })
  @IsEnum(KINDS)
  kind!: (typeof KINDS)[number];

  @ApiPropertyOptional({ example: "99f79587-ad8b-41a8-8b53-f502c36fe29b", description: "Required when kind is LEAVE" })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  leaveTypeId?: string;

  @ApiProperty({
    example: "2026-10-05",
    description: "First day covered, YYYY-MM-DD; a correction names one finished day",
  })
  @IsDateString()
  fromDate!: string;

  @ApiProperty({ example: "2026-10-07", description: "Last day covered, included; equals fromDate for a half day" })
  @IsDateString()
  toDate!: string;

  @ApiPropertyOptional({ example: false, description: "Half a day counts as 0.5 and covers one date" })
  @IsOptional()
  @IsBoolean()
  halfDay?: boolean;

  @ApiPropertyOptional({
    enum: DAY_PARTS,
    enumName: "DayPart",
    example: "MORNING",
    description: "Which half, when halfDay is set",
  })
  @IsOptional()
  @IsIn(DAY_PARTS)
  dayPart?: (typeof DAY_PARTS)[number];

  @ApiPropertyOptional({
    example: 150,
    description: "Minutes, for overtime and corrections; derived from fromAt and toAt when both are sent",
  })
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

  @ApiProperty({
    maxLength: 500,
    example: "Về quê dự đám cưới em gái",
    description: "Why, as the approver will read it",
  })
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;

  @ApiPropertyOptional({
    example: "https://files.example.com/requests/fix-nv0042-20261005.jpg",
    description: "A photo backing an attendance correction",
  })
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
  @ApiProperty({ example: "2026-12-30", description: "First day of the proposed leave, YYYY-MM-DD" })
  @IsDateString()
  fromDate!: string;

  @ApiProperty({ example: "2027-01-03", description: "Last day, included; no later than the next calendar year" })
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
  @ApiProperty({ example: true, description: "True approves it, false turns it down" })
  @IsBoolean()
  approve!: boolean;

  @ApiPropertyOptional({
    maxLength: NOTE_MAX,
    example: "Đã sắp xếp người làm thay",
    description: "What the decider tells the filer; shown on the request",
  })
  @IsOptional()
  @IsString()
  @MaxLength(NOTE_MAX)
  note?: string;
}

export class DecideManyDto {
  @ApiProperty({
    type: [String],
    maxItems: DECIDE_MANY_MAX,
    example: ["e3bf5f75-3ad5-4aca-9258-33e4a3357956", "bc174484-07dc-4483-8cf6-26acd66300bc"],
    description: "Request ids to decide; a repeated id counts once",
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(DECIDE_MANY_MAX)
  @IsString({ each: true })
  @MaxLength(ID_MAX, { each: true })
  ids!: string[];

  @ApiProperty({ example: true, description: "True approves them all, false turns them all down" })
  @IsBoolean()
  approve!: boolean;

  @ApiPropertyOptional({
    maxLength: NOTE_MAX,
    example: "Đã duyệt theo kế hoạch quý",
    description: "One reason for every row; required to turn down",
  })
  @IsOptional()
  @IsString()
  @MaxLength(NOTE_MAX)
  note?: string;
}

export class ListRequestsDto extends QueueQueryDto {
  @ApiPropertyOptional({
    enum: STATES,
    enumName: "RequestState",
    description: "The inbox reads only PENDING and ignores this",
  })
  @IsOptional()
  @IsEnum(STATES)
  state?: (typeof STATES)[number];

  @ApiPropertyOptional({ enum: KINDS, enumName: "RequestKind", description: "Only requests of this kind" })
  @IsOptional()
  @IsEnum(KINDS)
  kind?: (typeof KINDS)[number];

  @ApiPropertyOptional({ description: "One person's requests, still inside what the viewer may see" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  employeeId?: number;

  @ApiPropertyOptional({
    enum: SORTS,
    enumName: "RequestSort",
    description: "Ledger only; the inbox sorts on filing time",
  })
  @IsOptional()
  @IsIn(SORTS)
  sort?: RequestSort;
}

export class LeaveTypeRef {
  @ApiProperty({ example: "99f79587-ad8b-41a8-8b53-f502c36fe29b", description: "Leave type id (UUID)" })
  id!: string;

  @ApiProperty({ example: "ANNUAL", description: "Leave type code" })
  code!: string;

  @ApiProperty({ example: "Nghỉ phép năm", description: "Leave type name" })
  name!: string;

  @ApiProperty({ example: true, description: "False: no balance limits it (KEHOACH 9.5)" })
  paid!: boolean;
}

/** A request row alone, as filing, deciding and cancelling answer it. */
export class FiledRequestView {
  @ApiProperty({ example: "e3bf5f75-3ad5-4aca-9258-33e4a3357956", description: "Request id (UUID)" })
  id!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: "2dbf73fd-d71d-4d2a-bacd-0362ce6b4cff",
    description: "Key the filer minted so a resend lands on this row; null when none was sent",
  })
  clientKey!: string | null;

  @ApiProperty({ example: 42, description: "Employee who filed it" })
  employeeId!: number;

  @ApiProperty({ enum: KINDS, enumName: "RequestKind", example: "LEAVE", description: "What is asked for" })
  kind!: string;

  @ApiProperty({
    enum: STATES,
    enumName: "RequestState",
    example: "PENDING",
    description: "Where it stands; only PENDING can be decided or cancelled",
  })
  state!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: "99f79587-ad8b-41a8-8b53-f502c36fe29b",
    description: "Kind of leave; null for anything but LEAVE",
  })
  leaveTypeId!: string | null;

  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-10-05T00:00:00.000Z",
    description: "First day covered, sent as midnight UTC",
  })
  fromDate!: Date;

  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-10-07T00:00:00.000Z",
    description: "Last day covered, included, sent as midnight UTC",
  })
  toDate!: Date;

  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    example: "2026-10-05T10:30:00.000Z",
    description: "Overtime start or the claimed punch in; null when no time was sent",
  })
  fromAt!: Date | null;

  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    example: "2026-10-05T13:00:00.000Z",
    description: "Overtime end or the claimed punch out; null when no time was sent",
  })
  toAt!: Date | null;

  @ApiProperty({ example: false, description: "Half a day on one date, counted as 0.5" })
  halfDay!: boolean;

  @ApiProperty({
    enum: DAY_PARTS,
    enumName: "DayPart",
    nullable: true,
    example: "MORNING",
    description: "Which half of a half day; null otherwise",
  })
  dayPart!: string | null;

  @ApiProperty({ example: "3", description: "Working days for leave, a decimal sent as a string" })
  days!: string;

  @ApiProperty({ example: "0", description: "The part of days charged to the year after fromDate's" })
  nextYearDays!: string;

  @ApiProperty({ example: 150, description: "Minutes for overtime or a correction; 0 for other kinds" })
  minutes!: number;

  @ApiProperty({ example: "Về quê dự đám cưới em gái", description: "Why, in the filer's words" })
  reason!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: "https://files.example.com/requests/fix-nv0042-20261005.jpg",
    description: "Photo backing a correction; null when none",
  })
  attachmentUrl!: string | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 12,
    description: "Employee it waits on, a delegate when one stands in; null leaves it to the HR desk",
  })
  approverId!: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: "ab35f74f-dd47-4ad6-8e4c-fb243e7ac176",
    description: "Account that decided it; null while undecided",
  })
  decidedById!: string | null;

  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    example: "2026-09-30T03:12:44.000Z",
    description: "When it was approved or turned down; null while undecided",
  })
  decidedAt!: Date | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: "Đã sắp xếp người làm thay",
    description: "What the decider wrote; null when nothing",
  })
  decisionNote!: string | null;

  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-09-28T08:05:12.000Z",
    description: "When it was filed",
  })
  createdAt!: Date;

  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-09-30T03:12:44.000Z",
    description: "When the row last changed",
  })
  updatedAt!: Date;
}

export class RequestView extends FiledRequestView {
  @ApiProperty({ type: PersonView, description: "Who filed it, with their department" })
  employee!: PersonView;

  @ApiProperty({ type: LeaveTypeRef, nullable: true, description: "Kind of leave; null for anything but LEAVE" })
  leaveType!: LeaveTypeRef | null;

  @ApiProperty({ type: DeciderView, nullable: true, description: "Account that decided it; null while undecided" })
  decidedBy!: DeciderView | null;
}

export class InboxRowView extends RequestView {
  @ApiProperty({ example: 2, description: "Whole days since it was filed" })
  waitedDays!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 7.5,
    description: "Leave only: days left of this kind in fromDate's year once this is granted",
  })
  balanceAfter!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 12,
    description: "A request crossing into the next year: that year's balance once granted",
  })
  nextBalanceAfter!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 1,
    description: "Leave only: teammates under the same manager off on these dates",
  })
  overlapCount!: number | null;
}

export class RequestPageView extends PageMeta {
  @ApiProperty({ type: [RequestView], description: "This page of the ledger, in the order asked for" })
  rows!: RequestView[];
}

export class InboxPageView extends PageMeta {
  @ApiProperty({
    type: [InboxRowView],
    description: "What waits on this viewer, oldest first unless order says otherwise",
  })
  rows!: InboxRowView[];
}

export class InboxCountsView {
  @ApiProperty({ example: 4, description: "Requests waiting on this viewer to decide" })
  requests!: number;

  @ApiProperty({ example: 1, description: "Open payslip disputes; 0 for a role that does not answer them" })
  disputes!: number;

  @ApiProperty({
    example: 2,
    description: "Certificates asked for and not issued; 0 for a role that does not issue them",
  })
  certificates!: number;

  @ApiProperty({
    example: 0,
    description: "Profile changes waiting for review; 0 for a role that does not review them",
  })
  profileChanges!: number;

  @ApiProperty({ example: 1, description: "Dependant registrations waiting; 0 for a role that does not decide them" })
  dependents!: number;

  @ApiProperty({
    example: 0,
    description: "Salary advances waiting for a decision; 0 for a role that does not decide them",
  })
  advancesToDecide!: number;

  @ApiProperty({
    example: 3,
    description: "Approved advances waiting to be paid out; 0 for a role that does not pay them",
  })
  advancesToPay!: number;
}

export class SkippedView {
  @ApiProperty({ example: "bc174484-07dc-4483-8cf6-26acd66300bc", description: "Request id left undecided" })
  id!: string;

  @ApiProperty({
    example: "REQUEST_ALREADY_DECIDED",
    description: "The error code a single decision would have answered",
  })
  code!: string;
}

export class DecideManyView {
  @ApiProperty({
    type: [String],
    example: ["e3bf5f75-3ad5-4aca-9258-33e4a3357956"],
    description: "Request ids decided, in the order sent",
  })
  decided!: string[];

  @ApiProperty({ type: [SkippedView], description: "Request ids passed over, each with its reason" })
  skipped!: SkippedView[];
}

export class BalanceView {
  @ApiProperty({ example: "99f79587-ad8b-41a8-8b53-f502c36fe29b", description: "Leave type id (UUID)" })
  leaveTypeId!: string;

  @ApiProperty({ example: "ANNUAL", description: "Leave type code" })
  code!: string;

  @ApiProperty({ example: "Nghỉ phép năm", description: "Leave type name" })
  name!: string;

  @ApiProperty({ example: true, description: "Always true: an unpaid kind has no balance to show" })
  paid!: boolean;

  @ApiProperty({ example: 2026, description: "Calendar year the balance belongs to" })
  year!: number;

  @ApiProperty({ example: 12, description: "Days granted for the year" })
  entitled!: number;

  @ApiProperty({ example: 3, description: "Days carried in from the year before" })
  carriedOver!: number;

  @ApiProperty({ example: 4, description: "Days spent on approved leave" })
  taken!: number;

  @ApiProperty({ example: 1, description: "Days held by requests still waiting" })
  pending!: number;

  @ApiProperty({ example: 0, description: "Carried into the next year when this one closed" })
  carriedOut!: number;

  @ApiProperty({
    example: 10,
    description: "Days still free to book: entitled plus carried over, less taken, pending and carried out",
  })
  remaining!: number;

  @ApiProperty({ example: 2, description: "Days already booked after the chosen day, this year" })
  bookedAfter!: number;
}

export class OverlapView {
  @ApiProperty({ example: "bc174484-07dc-4483-8cf6-26acd66300bc", description: "The teammate's request id" })
  id!: string;

  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-10-06T00:00:00.000Z",
    description: "First day of their leave, sent as midnight UTC",
  })
  fromDate!: Date;

  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-10-08T00:00:00.000Z",
    description: "Last day of their leave, included, sent as midnight UTC",
  })
  toDate!: Date;

  @ApiProperty({
    enum: STATES,
    enumName: "RequestState",
    example: "APPROVED",
    description: "PENDING or APPROVED: only those keep a person away",
  })
  state!: string;

  @ApiProperty({ type: PersonView, description: "The teammate who is off" })
  employee!: PersonView;
}

export class RequestDetailView extends RequestView {
  @ApiProperty({ type: BalanceView, nullable: true, description: "The balance of this leave kind in fromDate's year" })
  balance!: BalanceView | null;

  @ApiProperty({ type: BalanceView, nullable: true, description: "The next year's, when the request crosses into it" })
  nextBalance!: BalanceView | null;

  @ApiProperty({ type: [OverlapView], description: "Teammates off on the same dates, twenty at most" })
  overlapping!: OverlapView[];

  @ApiProperty({ example: true, description: "Whether this viewer may approve or turn it down now" })
  mayDecide!: boolean;
}

export class LeaveDaysPartView {
  @ApiProperty({ example: 2026, description: "Calendar year the days are charged to" })
  year!: number;

  @ApiProperty({ example: 2, description: "Working days charged to this year" })
  days!: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    example: 8,
    description: "What this year keeps afterwards; null without a type, or for an unpaid one",
  })
  left!: number | null;
}

export class LeaveDaysView {
  @ApiProperty({ example: 3, description: "Days charged in all: working days, or every day for a calendar-day type" })
  days!: number;

  @ApiProperty({ example: true, description: "False for an unpaid type, which no balance limits" })
  limited!: boolean;

  @ApiProperty({ example: false, description: "The type counts every calendar day" })
  calendarDays!: boolean;

  @ApiProperty({ type: [LeaveDaysPartView], description: "One entry per calendar year the range touches" })
  parts!: LeaveDaysPartView[];
}
