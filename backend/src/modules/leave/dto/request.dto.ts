import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
} from "class-validator";

import { PaginationDto } from "../../../common/dto/pagination.dto.js";

const KINDS = ["LEAVE", "OVERTIME", "ATTENDANCE_FIX", "BUSINESS_TRIP", "REMOTE_WORK"] as const;
const STATES = ["DRAFT", "PENDING", "APPROVED", "REJECTED", "CANCELLED"] as const;

export class SubmitRequestDto {
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

  @ApiPropertyOptional({ description: "Half a day counts as 0.5" })
  @IsOptional()
  @IsBoolean()
  halfDay?: boolean;

  @ApiPropertyOptional({ description: "Minutes, for overtime and corrections" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  minutes?: number;

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

export class DecideRequestDto {
  @ApiProperty({ description: "True approves it, false turns it down" })
  @IsBoolean()
  approve!: boolean;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ListRequestsDto extends PaginationDto {
  @ApiPropertyOptional({ enum: STATES })
  @IsOptional()
  @IsEnum(STATES)
  state?: (typeof STATES)[number];

  @ApiPropertyOptional({ enum: KINDS })
  @IsOptional()
  @IsEnum(KINDS)
  kind?: (typeof KINDS)[number];

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  employeeId?: number;
}
