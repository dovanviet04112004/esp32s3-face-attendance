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
  @ApiProperty()
  @IsString()
  @MaxLength(64)
  payslipId!: string;

  @ApiPropertyOptional({ description: "Which line is disputed; left out means the whole slip" })
  @IsOptional()
  @IsString()
  @MaxLength(CODE_MAX)
  lineCode?: string;

  @ApiProperty({ maxLength: CLAIM_MAX, example: "Tăng ca tháng này thiếu 4 giờ" })
  @IsString()
  @MinLength(1)
  @MaxLength(CLAIM_MAX)
  claim!: string;
}

export class AnswerDisputeDto {
  @ApiProperty({ enum: OUTCOMES })
  @IsEnum(OUTCOMES)
  outcome!: (typeof OUTCOMES)[number];

  @ApiProperty({ maxLength: ANSWER_MAX })
  @IsString()
  @MinLength(1)
  @MaxLength(ANSWER_MAX)
  answer!: string;

  @ApiPropertyOptional({ description: "Dong owed; upholding without it settles nothing" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  amount?: number;

  @ApiPropertyOptional({ maxLength: CODE_MAX, example: "OT" })
  @IsOptional()
  @IsString()
  @MaxLength(CODE_MAX)
  code?: string;

  @ApiPropertyOptional({ maxLength: LABEL_MAX })
  @IsOptional()
  @IsString()
  @MaxLength(LABEL_MAX)
  label?: string;
}

export class ListDisputesDto extends QueueQueryDto {
  @ApiPropertyOptional({ enum: STATES, description: "OPEN is the desk's queue, without its own rows" })
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
  @ApiProperty()
  year!: number;

  @ApiProperty()
  month!: number;
}

export class DisputedSlip {
  @ApiProperty({ type: PeriodRef })
  period!: PeriodRef;
}

export class DisputeView {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  payslipId!: string;

  @ApiProperty()
  employeeId!: number;

  @ApiProperty({ nullable: true })
  lineCode!: string | null;

  @ApiProperty()
  claim!: string;

  @ApiProperty({ enum: STATES })
  state!: string;

  @ApiProperty()
  dueAt!: Date;

  @ApiProperty({ enum: OUTCOMES, nullable: true })
  outcome!: string | null;

  @ApiProperty({ nullable: true })
  answer!: string | null;

  @ApiProperty({ nullable: true })
  answeredAt!: Date | null;

  @ApiProperty({ nullable: true, description: "The adjustment an upheld answer paid through" })
  retroId!: string | null;

  @ApiProperty()
  createdAt!: Date;
}

export class DisputeRowView extends DisputeView {
  @ApiProperty({ type: PersonView })
  employee!: PersonView;

  @ApiProperty({ type: DisputedSlip })
  payslip!: DisputedSlip;

  @ApiProperty({ description: "Whole days since it was raised" })
  waitedDays!: number;
}

export class DisputePageView extends PageMeta {
  @ApiProperty({ type: [DisputeRowView] })
  rows!: DisputeRowView[];
}
