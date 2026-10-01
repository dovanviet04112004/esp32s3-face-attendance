import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import { IsBoolean, IsDateString, IsInt, IsOptional, IsString, MaxLength, Min } from "class-validator";

import { PaginationDto } from "../../../common/dto/pagination.dto.js";

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
}
