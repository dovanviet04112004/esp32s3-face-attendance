import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import { IsBoolean, IsEnum, IsInt, IsString, MaxLength, Min, IsOptional } from "class-validator";

import { PageMeta, PersonView, QueueQueryDto } from "../../leave/dto/queue.dto.js";

const STATES = ["PENDING", "APPROVED", "REJECTED", "PAID", "SETTLED", "CANCELLED"] as const;

export class RequestAdvanceDto {
  @ApiProperty({ example: 3000000, description: "Whole VND asked for; the next payslip deducts it once paid" })
  @IsInt()
  @Min(1)
  amount!: number;

  @ApiProperty({ example: "Viec gia dinh", description: "Why, as the desk will read it" })
  @IsString()
  @MaxLength(500)
  reason!: string;
}

export class ListAdvancesDto extends QueueQueryDto {
  @ApiPropertyOptional({
    enum: STATES,
    enumName: "AdvanceState",
    description: "PENDING is the queue to decide, APPROVED the queue to pay",
  })
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
  @ApiProperty({ example: true, description: "True approves it, false turns it down; paying is a separate step" })
  @IsBoolean()
  approve!: boolean;

  @ApiPropertyOptional({ example: "Đã đối chiếu lương tháng", description: "What the desk tells the person" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class AdvanceView {
  @ApiProperty({ example: "ee5e4c9f-9f5c-4ebd-8759-9b7ac5ed3696", description: "Advance id (UUID)" })
  id!: string;

  @ApiProperty({ example: 42, description: "Employee who asked for it" })
  employeeId!: number;

  @ApiProperty({ example: "3000000", description: "Dong, a decimal sent as a string" })
  amount!: string;

  @ApiProperty({ example: "Viec gia dinh", description: "Why, in the person's words" })
  reason!: string;

  @ApiProperty({
    enum: STATES,
    enumName: "AdvanceState",
    example: "PENDING",
    description: "PAID is outstanding until a locked payslip deducts it, which makes it SETTLED",
  })
  state!: string;

  @ApiProperty({
    type: String,
    format: "date-time",
    example: "2026-09-12T02:15:00.000Z",
    description: "When it was asked for",
  })
  requestedAt!: Date;

  @ApiProperty({
    type: String,
    nullable: true,
    example: "ab35f74f-dd47-4ad6-8e4c-fb243e7ac176",
    description: "Account that decided it; null while pending or cancelled",
  })
  decidedById!: string | null;

  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    example: "2026-09-12T08:40:00.000Z",
    description: "When it was decided; null while pending or cancelled",
  })
  decidedAt!: Date | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: "Đã đối chiếu lương tháng",
    description: "What the desk wrote; null if nothing",
  })
  decisionNote!: string | null;

  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    example: "2026-09-13T03:00:00.000Z",
    description: "When the money went out; null until paid",
  })
  paidAt!: Date | null;

  @ApiProperty({
    type: String,
    format: "date-time",
    nullable: true,
    example: "2026-10-02T09:30:00.000Z",
    description: "When a locked payslip deducted it; null until then",
  })
  settledAt!: Date | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: "8f14e45f-ceea-467a-9575-7e4f3c2a1b90",
    description: "Payslip that deducts it; null until a finished run picks it up",
  })
  payslipId!: string | null;
}

export class AdvanceRowView extends AdvanceView {
  @ApiProperty({ type: PersonView, description: "Who asked for it" })
  employee!: PersonView;

  @ApiProperty({ example: 1, description: "Whole days since it was asked for" })
  waitedDays!: number;

  @ApiProperty({
    type: String,
    nullable: true,
    example: "20000000",
    description: "Desk only: the latest base pay, dong",
  })
  baseSalary!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: "0",
    description: "Desk only: other advances approved or paid and not yet deducted, dong",
  })
  outstanding!: string | null;
}

export class AdvancePageView extends PageMeta {
  @ApiProperty({
    type: [AdvanceRowView],
    description: "Oldest first for the PENDING and APPROVED queues, newest first otherwise, unless order says",
  })
  rows!: AdvanceRowView[];
}
