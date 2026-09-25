import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsBoolean, IsEnum, IsInt, IsString, MaxLength, Min, IsOptional } from "class-validator";

import { PageMeta, PersonView, QueueQueryDto } from "../../leave/dto/queue.dto.js";

const STATES = ["PENDING", "APPROVED", "REJECTED", "PAID", "SETTLED", "CANCELLED"] as const;

export class RequestAdvanceDto {
  @ApiProperty({ example: 3000000 })
  @IsInt()
  @Min(1)
  amount!: number;

  @ApiProperty({ example: "Viec gia dinh" })
  @IsString()
  @MaxLength(500)
  reason!: string;
}

export class ListAdvancesDto extends QueueQueryDto {
  @ApiPropertyOptional({ enum: STATES, description: "PENDING is the queue to decide, APPROVED the queue to pay" })
  @IsOptional()
  @IsEnum(STATES)
  state?: (typeof STATES)[number];

  @ApiPropertyOptional({ description: "One person's advances, still inside what the viewer may see" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  employeeId?: number;
}

export class DecideAdvanceDto {
  @ApiProperty()
  @IsBoolean()
  approve!: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class AdvanceView {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  employeeId!: number;

  @ApiProperty({ example: "3000000", description: "Dong, a decimal sent as a string" })
  amount!: string;

  @ApiProperty()
  reason!: string;

  @ApiProperty({ enum: STATES })
  state!: string;

  @ApiProperty()
  requestedAt!: Date;

  @ApiProperty({ nullable: true })
  decidedAt!: Date | null;

  @ApiProperty({ nullable: true })
  decisionNote!: string | null;

  @ApiProperty({ nullable: true })
  paidAt!: Date | null;
}

export class AdvanceRowView extends AdvanceView {
  @ApiProperty({ type: PersonView })
  employee!: PersonView;

  @ApiProperty({ description: "Whole days since it was asked for" })
  waitedDays!: number;

  @ApiProperty({ nullable: true, description: "Desk only: the latest base pay, dong" })
  baseSalary!: string | null;

  @ApiProperty({ nullable: true, description: "Desk only: other advances approved or paid and not yet deducted, dong" })
  outstanding!: string | null;
}

export class AdvancePageView extends PageMeta {
  @ApiProperty({ type: [AdvanceRowView] })
  rows!: AdvanceRowView[];
}
