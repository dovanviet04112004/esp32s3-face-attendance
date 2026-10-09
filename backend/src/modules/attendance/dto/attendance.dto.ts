import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
} from "class-validator";

import { PaginationDto } from "../../../common/dto/pagination.dto.js";
import { PageMeta, PersonView, QueueQueryDto } from "../../leave/dto/queue.dto.js";

/** A punch id as the API carries it: a BIGINT in decimal. */
export const PUNCH_ID = /^\d{1,19}$/;
export const DECIDE_PUNCHES_MAX = 100;
const NOTE_MAX = 500;

export class ListAttendanceDto extends PaginationDto {
  @ApiPropertyOptional({ description: "Only this employee's punches" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  employeeId?: number;

  @ApiPropertyOptional({ description: "Only punches taken on this kiosk" })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  deviceId?: string;

  @ApiPropertyOptional({
    example: "2026-09-01T00:00:00.000Z",
    description: "Earliest capture time, an ISO instant, included",
  })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({
    example: "2026-09-30T23:59:59.000Z",
    description: "Capture time the range stops before, an ISO instant, excluded",
  })
  @IsOptional()
  @IsDateString()
  to?: string;

  // Boolean("false") is true, so a query string has to be compared, not cast.
  @ApiPropertyOptional({ description: "Only punches the kiosk took while it was offline" })
  @IsOptional()
  @Transform(({ value }) => value === true || value === "true")
  @IsBoolean()
  capturedOffline?: boolean;

  @ApiPropertyOptional({ description: "Only punches stamped by a clock that had not synced" })
  @IsOptional()
  @Transform(({ value }) => value === true || value === "true")
  @IsBoolean()
  clockUnsynced?: boolean;

  @ApiPropertyOptional({
    description: "Only punches whose own time is past believing; from and to then bound when the server heard them",
  })
  @IsOptional()
  @Transform(({ value }) => value === true || value === "true")
  @IsBoolean()
  questionableTime?: boolean;

  @ApiPropertyOptional({ description: "Only punches stored but waiting for HR before they count (KEHOACH 9.8)" })
  @IsOptional()
  @Transform(({ value }) => value === true || value === "true")
  @IsBoolean()
  held?: boolean;
}

export class PunchView {
  @ApiProperty({ type: String, example: "1842", description: "Decimal string" }) id!: string;
  @ApiProperty({
    example: "4294967403",
    description: "The kiosk's own counter for the punch, a decimal string; unique together with deviceId",
  })
  localId!: string;
  @ApiProperty({ example: "kiosk-2884859fd3c8", description: "Kiosk that took it" }) deviceId!: string;
  @ApiProperty({ example: 42, description: "Employee the kiosk recognised" }) employeeId!: number;
  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-09-14T01:02:11.000Z",
    description: "Capture time the kiosk stamped",
  })
  ts!: string;
  @ApiProperty({
    enum: ["IN", "OUT"],
    enumName: "PunchDirection",
    example: "IN",
    description: "Which way the kiosk judged the person was going",
  })
  direction!: string;
  @ApiProperty({
    type: Number,
    nullable: true,
    example: 0.82,
    description: "Cosine similarity to the matched template, -1 to 1; null when not sent",
  })
  score!: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    example: 0.97,
    description: "Liveness score, 0 to 1; null when not sent",
  })
  livenessScore!: number | null;
  @ApiProperty({ example: true, description: "The kiosk opened the door for it" }) doorOpened!: boolean;
  @ApiProperty({ example: false, description: "Taken while the broker was unreachable" }) capturedOffline!: boolean;
  @ApiProperty({ example: false, description: "Stamped before the kiosk's first NTP sync; the time is approximate" })
  clockUnsynced!: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    format: "date-time",
    example: "2026-09-14T01:02:12.000Z",
    description: "When the server heard it",
  })
  receivedAt!: string | null;
  @ApiProperty({ example: false, description: "Before 2020 or more than a day after receivedAt; counted in no day" })
  questionableTime!: boolean;
  @ApiProperty({
    enum: ["LATE", "CLOSED_PERIOD"],
    enumName: "PunchHold",
    nullable: true,
    example: null,
    description: "Why the punch waited for HR: too far behind its receipt, or its day in a locked period; null when it counted at once",
  })
  hold!: string | null;
  @ApiProperty({
    enum: ["PENDING", "ACCEPTED", "REJECTED"],
    enumName: "PunchReview",
    nullable: true,
    example: null,
    description: "HR's decision on a held punch; only a null or ACCEPTED one counts",
  })
  review!: string | null;
  @ApiProperty({ type: String, nullable: true, example: null, description: "User who decided it" })
  reviewedById!: string | null;
  @ApiProperty({ type: String, nullable: true, format: "date-time", example: null, description: "When it was decided" })
  reviewedAt!: string | null;
  @ApiProperty({ type: String, nullable: true, example: null, description: "Why it was turned down" })
  reviewNote!: string | null;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "https://files.example.com/punches/1842.jpg",
    description: "Link to a capture photo; null, as no kiosk sends one",
  })
  photoUrl!: string | null;
  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-09-14T01:02:12.000Z",
    description: "When the row was written",
  })
  createdAt!: string;
}

export class PunchPageView {
  @ApiProperty({ type: [PunchView], description: "Newest capture time first" }) rows!: PunchView[];
  @ApiProperty({ example: 5280, description: "Punches the filter reaches, counted no further than the ceiling" })
  total!: number;
  @ApiProperty({ example: true, description: "False when counting stopped at the ceiling, so total is a floor" })
  totalIsExact!: boolean;
  @ApiProperty({
    type: String,
    nullable: true,
    example: "eyJzb3J0VmFsdWUiOiIyMDI2LTA5LTE0VDAxOjMyOjA1LjAwMFoiLCJpZCI6IjE4NDIifQ",
    description: "Cursor for the next page, sent back as cursor; null once a page comes back short",
  })
  next!: string | null;
}

export class PunchCountsView {
  @ApiProperty({ example: 5280, description: "Punches captured inside the range" }) all!: number;
  @ApiProperty({ example: 37, description: "Of those, taken while the kiosk was offline" }) capturedOffline!: number;
  @ApiProperty({ example: 4, description: "Of those, stamped by a clock that had not synced" }) clockUnsynced!: number;
  @ApiProperty({ example: 1, description: "Questionable punches heard inside the range" }) questionableTime!: number;
  @ApiProperty({ example: 2, description: "Of the punches captured inside the range, those waiting for HR" }) held!: number;
}

/** The punches held for review that wait on the viewer; from and to bound the day the server heard them (KEHOACH 9.8). */
export class ListHeldDto extends QueueQueryDto {}

export class DecidePunchDto {
  @ApiProperty({ example: true, description: "True lets the punch count, false turns it down for good" })
  @IsBoolean()
  approve!: boolean;

  @ApiPropertyOptional({
    maxLength: NOTE_MAX,
    example: "Máy mất mạng cả tuần, lượt thật",
    description: "Why; required to turn down",
  })
  @IsOptional()
  @IsString()
  @MaxLength(NOTE_MAX)
  note?: string;
}

export class DecidePunchesDto extends DecidePunchDto {
  @ApiProperty({
    type: [String],
    maxItems: DECIDE_PUNCHES_MAX,
    example: ["1842", "1843"],
    description: "Punch ids, decimal strings; a repeated id counts once",
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(DECIDE_PUNCHES_MAX)
  @IsString({ each: true })
  @Matches(PUNCH_ID, { each: true })
  ids!: string[];
}

export class HeldPunchView extends PunchView {
  @ApiProperty({ type: PersonView, description: "Whose punch it is" }) employee!: PersonView;
  @ApiProperty({ example: 3, description: "Whole days since the server heard it" }) waitedDays!: number;
}

export class HeldPageView extends PageMeta {
  @ApiProperty({ type: [HeldPunchView], description: "Oldest receipt first unless asked otherwise" })
  rows!: HeldPunchView[];
}

export class PunchSkippedView {
  @ApiProperty({ example: "1843", description: "Punch id left undecided" }) id!: string;
  @ApiProperty({ example: "PUNCH_ALREADY_DECIDED", description: "The error code a single decision would have answered" })
  code!: string;
}

export class DecidePunchesView {
  @ApiProperty({ type: [String], example: ["1842"], description: "Punch ids decided, in the order sent" })
  decided!: string[];
  @ApiProperty({ type: [PunchSkippedView], description: "Punch ids passed over, each with its reason" })
  skipped!: PunchSkippedView[];
}
