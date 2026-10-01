import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform, Type } from "class-transformer";
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";

import { PageMeta, PersonView, QueueQueryDto } from "../../leave/dto/queue.dto.js";

const STATES = ["OPEN", "ANSWERED", "WITHDRAWN"] as const;
const OUTCOMES = ["UPHELD", "REJECTED"] as const;
const CLAIM_MAX = 2000;
const ANSWER_MAX = 2000;
const CODE_MAX = 32;
const LABEL_MAX = 64;

export class RaiseDisputeDto {
  @ApiProperty({
    example: "8f14e45f-ceea-467a-9575-7e4f3c2a1b90",
    description: "One of the caller's own payslips, already issued",
  })
  @IsString()
  @MaxLength(64)
  payslipId!: string;

  @ApiPropertyOptional({ example: "OT_WEEKDAY", description: "Which line is disputed; left out means the whole slip" })
  @IsOptional()
  @IsString()
  @MaxLength(CODE_MAX)
  lineCode?: string;

  @ApiProperty({
    maxLength: CLAIM_MAX,
    example: "Tăng ca tháng này thiếu 4 giờ",
    description: "What the person says is wrong",
  })
  @IsString()
  @MinLength(1)
  @MaxLength(CLAIM_MAX)
  claim!: string;
}

export class AnswerDisputeDto {
  @ApiProperty({
    enum: OUTCOMES,
    enumName: "DisputeOutcome",
    example: "UPHELD",
    description: "UPHELD agrees with the claim, REJECTED does not",
  })
  @IsEnum(OUTCOMES)
  outcome!: (typeof OUTCOMES)[number];

  @ApiProperty({
    maxLength: ANSWER_MAX,
    example: "Đã đối chiếu máy chấm công, bổ sung 4 giờ tăng ca vào kỳ sau",
    description: "The answer the person reads; also the adjustment's reason",
  })
  @IsString()
  @MinLength(1)
  @MaxLength(ANSWER_MAX)
  answer!: string;

  @ApiPropertyOptional({ example: 450000, description: "Dong owed; upholding without it settles nothing" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  amount?: number;

  @ApiPropertyOptional({
    maxLength: CODE_MAX,
    example: "OT",
    description: "Code of the adjustment, DISPUTE when left out; the next payslip shows RETRO_<code>",
  })
  @IsOptional()
  @IsString()
  @MaxLength(CODE_MAX)
  code?: string;

  @ApiPropertyOptional({
    maxLength: LABEL_MAX,
    example: "Bù tăng ca tháng 9",
    description: "Label of the adjustment line on the next payslip",
  })
  @IsOptional()
  @IsString()
  @MaxLength(LABEL_MAX)
  label?: string;
}

export class ListDisputesDto extends QueueQueryDto {
  @ApiPropertyOptional({
    enum: STATES,
    enumName: "DisputeState",
    description: "OPEN is the desk's queue, without its own rows",
  })
  @IsOptional()
  @IsEnum(STATES)
  state?: (typeof STATES)[number];

  // Boolean("false") is true, so a query string has to be compared, not cast.
  @ApiPropertyOptional({ description: "Only the ones still open past their deadline" })
  @IsOptional()
  @Transform(({ value }) => value === true || value === "true")
  @IsBoolean()
  overdue?: boolean;

  @ApiPropertyOptional({ description: "One person's disputes, still inside what the viewer may see" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  employeeId?: number;
}

export class PeriodRef {
  @ApiProperty({ example: 2026, description: "Calendar year of the pay month" })
  year!: number;

  @ApiProperty({ example: 9, description: "Pay month, 1 for January" })
  month!: number;
}

export class DisputedSlip {
  @ApiProperty({ type: PeriodRef, description: "The pay month of the disputed payslip" })
  period!: PeriodRef;
}

export class DisputeView {
  @ApiProperty({ example: "6ccf84bd-c7d6-4ee6-9217-aa0aaa9380ac", description: "Dispute id (UUID)" })
  id!: string;

  @ApiProperty({ example: "8f14e45f-ceea-467a-9575-7e4f3c2a1b90", description: "Payslip disputed" })
  payslipId!: string;

  @ApiProperty({ example: 42, description: "Employee who raised it" })
  employeeId!: number;

  @ApiProperty({
    type: String,
    nullable: true,
    example: "OT_WEEKDAY",
    description: "Line disputed; null for the whole payslip",
  })
  lineCode!: string | null;

  @ApiProperty({ example: "Tăng ca tháng này thiếu 4 giờ", description: "What the person says is wrong" })
  claim!: string;

  @ApiProperty({
    enum: STATES,
    enumName: "DisputeState",
    example: "OPEN",
    description: "Only OPEN can be answered or withdrawn",
  })
  state!: string;

  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-10-08T03:00:00.000Z",
    description: "Deadline for an answer, DISPUTE_ANSWER_DAYS after it was raised",
  })
  dueAt!: Date;

  @ApiProperty({
    enum: OUTCOMES,
    enumName: "DisputeOutcome",
    nullable: true,
    example: "UPHELD",
    description: "What the answer decided; null until answered",
  })
  outcome!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: "Đã đối chiếu máy chấm công, bổ sung 4 giờ tăng ca vào kỳ sau",
    description: "The desk's answer; null until answered",
  })
  answer!: string | null;

  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    example: "2026-10-06T07:20:00.000Z",
    description: "When it was answered; null until then",
  })
  answeredAt!: Date | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: "ab35f74f-dd47-4ad6-8e4c-fb243e7ac176",
    description: "Account that answered it; null until answered",
  })
  answeredById!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: "46ce4574-f962-4aa5-a112-c5997ab36056",
    description: "The adjustment an upheld answer paid through",
  })
  retroId!: string | null;

  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-10-03T03:00:00.000Z",
    description: "When it was raised",
  })
  createdAt!: Date;

  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-10-06T07:20:00.000Z",
    description: "When the row last changed",
  })
  updatedAt!: Date;
}

export class DisputeRowView extends DisputeView {
  @ApiProperty({ type: PersonView, description: "Who raised it" })
  employee!: PersonView;

  @ApiProperty({ type: DisputedSlip, description: "The disputed payslip's pay month" })
  payslip!: DisputedSlip;

  @ApiProperty({ example: 3, description: "Whole days since it was raised" })
  waitedDays!: number;
}

export class DisputeDetailView extends DisputeRowView {
  @ApiProperty({ type: String, nullable: true, example: "Phạm Văn D", description: "Who answered it; null while it is open" })
  decidedByName!: string | null;
}

export class DisputePageView extends PageMeta {
  @ApiProperty({
    type: [DisputeRowView],
    description: "Oldest first when listing open ones, newest first otherwise, unless order says",
  })
  rows!: DisputeRowView[];
}
